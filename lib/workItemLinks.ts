import { remark } from 'remark';
import remarkGfm from 'remark-gfm';

/**
 * Turns bare work item IDs (e.g. ADO `5809224` or `#5809224`) in agent markdown into links, using a
 * per-agent URL template such as `https://dev.azure.com/org/project/_workitems/edit/{id}`.
 */

const parser = remark().use(remarkGfm);
const SKIPPED_NODES = new Set(['link', 'linkReference', 'definition', 'image', 'imageReference', 'inlineCode', 'code', 'html']);
// 6–8 digit numbers that are not part of a longer token, decimal, path or query string.
const WORK_ITEM_ID_RE = /(?<![\w./=&?\\-])#?(\d{6,8})(?!\w|[.,]\d|\/\w)/g;
const URL_UNSAFE: Record<string, string> = { ' ': '%20', '(': '%28', ')': '%29', '<': '%3C', '>': '%3E' };

/** Returns the trimmed template if it is an http(s) URL containing `{id}`, otherwise ''. */
export function normalizeWorkItemUrlTemplate(raw: unknown): string {
  const template = typeof raw === 'string' ? raw.trim() : '';
  if (!template.includes('{id}')) return '';
  try {
    const url = new URL(template.replaceAll('{id}', '1'));
    return url.protocol === 'https:' || url.protocol === 'http:' ? template : '';
  } catch {
    return '';
  }
}

export function workItemUrl(template: string, id: string): string {
  return template.replaceAll('{id}', id).replace(/[ ()<>]/g, (c) => URL_UNSAFE[c]);
}

type MdNode = { type: string; children?: MdNode[]; position?: { start: { offset?: number }; end: { offset?: number } } };

export function linkWorkItems(markdown: string, template: string | undefined): string {
  if (!markdown || !template || !/\d{6}/.test(markdown)) return markdown;
  const normalized = normalizeWorkItemUrlTemplate(template);
  if (!normalized) return markdown;

  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: MdNode) => {
    if (SKIPPED_NODES.has(node.type)) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === 'text' && start !== undefined && end !== undefined) {
      for (const match of markdown.slice(start, end).matchAll(WORK_ITEM_ID_RE)) {
        const at = start + match.index!;
        edits.push({ start: at, end: at + match[0].length, text: `[${match[0]}](${workItemUrl(normalized, match[1])})` });
      }
    }
    node.children?.forEach(visit);
  };
  visit(parser.parse(markdown) as MdNode);

  let result = markdown;
  for (const edit of edits.reverse()) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}
