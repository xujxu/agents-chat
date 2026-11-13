'use client';

import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent } from 'react';
import type { ChatAttachment } from '../../composer/attachmentTypes';
import { filesToAttachments } from '../../composer/attachmentHelpers';
import { STORAGE_CHAT_INPUT } from './sessionPersistence';

const TYPING_IDLE_MS = 1000;
const COMPOSER_MIN_HEIGHT = 28;
const COMPOSER_MAX_HEIGHT = 300;
const MIRRORED_TEXTAREA_STYLES = [
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch',
  'letterSpacing', 'wordSpacing', 'lineHeight', 'textTransform', 'textIndent', 'tabSize',
  'whiteSpace', 'wordBreak', 'overflowWrap', 'direction',
] as const;
let measureTextarea: HTMLTextAreaElement | null = null;

function measureTextareaContentHeight(el: HTMLTextAreaElement): number {
  if (!measureTextarea || !measureTextarea.isConnected) {
    measureTextarea = document.createElement('textarea');
    measureTextarea.setAttribute('aria-hidden', 'true');
    measureTextarea.tabIndex = -1;
    measureTextarea.rows = 1;
    Object.assign(measureTextarea.style, {
      position: 'absolute', top: '0', left: '-10000px', visibility: 'hidden',
      boxSizing: 'border-box',
      pointerEvents: 'none', height: '0px', minHeight: '0', maxHeight: 'none',
      overflow: 'hidden', resize: 'none',
    });
    document.body.appendChild(measureTextarea);
  }
  const computed = getComputedStyle(el);
  for (const prop of MIRRORED_TEXTAREA_STYLES) measureTextarea.style[prop] = computed[prop];
  measureTextarea.style.width = `${el.getBoundingClientRect().width}px`;
  measureTextarea.value = el.value;
  return measureTextarea.scrollHeight;
}

export function useComposerState() {
  const [input, setInput] = useState('');
  const inputRef = useRef('');
  const inputRevisionRef = useRef(0);
  const inputDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingIdleRef = useRef<{ timer: ReturnType<typeof setTimeout>; main: Element } | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputHistoryIndexRef = useRef(-1);
  const inputDraftRef = useRef('');
  // Stores link mappings from rich text paste: linkText → href
  const pastedLinksRef = useRef<Array<{ text: string; href: string }>>([]);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDraggingAttachment, setIsDraggingAttachment] = useState(false);
  const [mounted, setMounted] = useState(false);

  const resizeComposer = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    // Collapsing the live textarea to measure it moves the caret out of view, so
    // iOS scrolls the visual viewport on every keystroke. Measure a mirror instead.
    const contentHeight = measureTextareaContentHeight(el);
    const next = `${Math.min(Math.max(contentHeight, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT)}px`;
    const overflowY = contentHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden';
    if (el.style.height !== next) el.style.height = next;
    if (el.style.overflowY !== overflowY) el.style.overflowY = overflowY;
  }, []);

  const setInputProgrammatic = useCallback((value: string) => {
    inputRevisionRef.current++;
    inputRef.current = value;
    if (!value) pastedLinksRef.current = [];
    if (inputDebounceRef.current) clearTimeout(inputDebounceRef.current);
    setInput(value);
    if (composerRef.current) {
      composerRef.current.value = value;
      resizeComposer();
    }
  }, [resizeComposer]);

  const markComposerTyping = useCallback((el: HTMLTextAreaElement) => {
    const main = el.closest('.chatMain');
    if (!main) return;
    const previous = typingIdleRef.current;
    if (previous) {
      clearTimeout(previous.timer);
      if (previous.main !== main) previous.main.classList.remove('composerTyping');
    }
    // Running animations delay keystroke paints by about a frame on long chats.
    main.classList.add('composerTyping');
    typingIdleRef.current = {
      main,
      timer: setTimeout(() => {
        main.classList.remove('composerTyping');
        typingIdleRef.current = null;
      }, TYPING_IDLE_MS),
    };
  }, []);

  const composerInputHandler = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    inputRevisionRef.current++;
    inputRef.current = el.value;
    resizeComposer();
    markComposerTyping(el);
    if (inputDebounceRef.current) clearTimeout(inputDebounceRef.current);
    inputDebounceRef.current = setTimeout(() => {
      startTransition(() => setInput(composerRef.current?.value || ''));
    }, 300);
  }, [markComposerTyping, resizeComposer]);

  async function addFilesToComposer(fileList: FileList | File[]) {
    const files = Array.from(fileList).filter(Boolean);
    if (!files.length) return;
    try {
      const result = await filesToAttachments(files, attachments);
      if (result.error) { setAttachmentError(result.error); return; }
      setAttachments(prev => [...prev, ...result.attachments]);
      setAttachmentError(null);
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : 'Failed to read attachment.');
    }
  }

  function removeAttachment(id: string) { setAttachments(prev => prev.filter(a => a.id !== id)); setAttachmentError(null); }
  function clearAttachments() { setAttachments([]); setAttachmentError(null); }

  function prepareSubmission() {
    const revision = inputRevisionRef.current;
    let text = (inputRef.current || composerRef.current?.value || '').trim();
    for (const { text: linkText, href } of pastedLinksRef.current) {
      const index = text.indexOf(linkText);
      if (index !== -1) text = `${text.slice(0, index)}[${linkText}](${href})${text.slice(index + linkText.length)}`;
    }
    const submittedIds = new Set(attachments.map(attachment => attachment.id));
    return {
      text, attachments,
      onStaged() {
        if (inputRevisionRef.current === revision) setInputProgrammatic('');
        setAttachments(current => current.filter(attachment => !submittedIds.has(attachment.id)));
      },
    };
  }

  function getFilesFromClipboard(event: ClipboardEvent<HTMLTextAreaElement>): File[] {
    const files: File[] = [];
    const seen = new Set<string>();
    const addFile = (file: File | null) => {
      if (!file) return;
      const key = `${file.name.trim().toLowerCase()}:${file.size}:${file.type.trim().toLowerCase()}`;
      if (!seen.has(key)) { seen.add(key); files.push(file); }
    };
    const clipFiles = Array.from(event.clipboardData.files || []);
    if (clipFiles.length) clipFiles.forEach(addFile);
    else Array.from(event.clipboardData.items || []).forEach(item => { if (item.kind === 'file') addFile(item.getAsFile()); });
    return files;
  }

  function handleAttachmentPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = getFilesFromClipboard(event);
    if (files.length > 0) {
      event.preventDefault();
      void addFilesToComposer(files);
      return;
    }
    // Store hyperlink mappings from rich text paste (links applied on send)
    const html = event.clipboardData.getData('text/html');
    if (html) {
      const container = document.createElement('div');
      container.innerHTML = html;
      const anchors = container.querySelectorAll('a[href]');
      if (anchors.length > 0) {
        const newLinks: Array<{ text: string; href: string }> = [];
        anchors.forEach((a) => {
          const href = (a as HTMLAnchorElement).href || a.getAttribute('href') || '';
          const linkText = (a.textContent || '').trim().replace(/\s+/g, ' ');
          if (!href || !linkText) return;
          if (linkText === href || linkText === href.replace(/\/$/, '')) return;
          if (!/^(https?:|mailto:)/i.test(href)) return;
          newLinks.push({ text: linkText, href });
        });
        if (newLinks.length > 0) {
          pastedLinksRef.current = [...pastedLinksRef.current, ...newLinks];
        }
      }
    }
    // Let browser handle default paste (plain text into textarea)
  }

  function dataTransferHasFiles(event: DragEvent<HTMLElement>) { return Array.from(event.dataTransfer.types || []).includes('Files'); }
  function handleComposerDragOver(event: DragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setIsDraggingAttachment(true);
  }
  function handleComposerDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDraggingAttachment(false);
  }
  function handleComposerDrop(event: DragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event)) return;
    event.preventDefault(); setIsDraggingAttachment(false); void addFilesToComposer(event.dataTransfer.files);
  }

  useEffect(() => {
    setMounted(true);
    const savedInput = window.localStorage.getItem(STORAGE_CHAT_INPUT);
    if (savedInput) setInputProgrammatic(savedInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    const typing = typingIdleRef.current;
    if (!typing) return;
    clearTimeout(typing.timer);
    typing.main.classList.remove('composerTyping');
  }, []);

  useEffect(() => {
    if (!mounted) return;
    window.localStorage.setItem(STORAGE_CHAT_INPUT, input);
  }, [input, mounted]);

  return {
    input, inputRef, composerRef, fileInputRef, inputHistoryIndexRef, inputDraftRef, pastedLinksRef,
    attachments, attachmentError, isDraggingAttachment, mounted, setInputProgrammatic,
    composerInputHandler, resizeComposer, addFilesToComposer, removeAttachment, clearAttachments, prepareSubmission,
    handleAttachmentPaste, handleComposerDragOver, handleComposerDragLeave, handleComposerDrop,
  };
}
