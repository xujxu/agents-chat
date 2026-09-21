"""Independent official Python binding path for diagnosing release-CLI output."""

import json
import sys

import sherpa_onnx
import soundfile as sf


recognizer = sherpa_onnx.OfflineRecognizer.from_funasr_nano(
    encoder_adaptor="model/encoder_adaptor.int8.onnx",
    embedding="model/embedding.int8.onnx",
    llm="model/llm.int8.onnx",
    tokenizer="model/Qwen3-0.6B",
    num_threads=2, provider="cpu", debug=False,
    system_prompt="You are a helpful assistant.",
    user_prompt="\u8bed\u97f3\u8f6c\u5199\uff1a",
    max_new_tokens=512, temperature=1e-6, top_p=0.8, seed=42,
    language="", itn=True, hotwords="",
)
audio, rate = sf.read(sys.argv[1], dtype="float32")
if audio.ndim != 1 or rate != 16000:
    raise ValueError("Expected mono 16kHz input")
stream = recognizer.create_stream()
stream.accept_waveform(rate, audio)
recognizer.decode_stream(stream)
print(json.dumps({"text": stream.result.text, "tokens": stream.result.tokens}, ensure_ascii=False))
