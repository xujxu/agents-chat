"""Strict diagnostic input boundary and verbatim pinned frontend extraction."""

import hashlib
import math
from pathlib import Path
import struct


def sha(data):
    return hashlib.sha256(data).hexdigest()


def extract_block(source):
    start, end = "static const int FS=16000", "struct cfg {"
    if source.count(start) != 1 or source.count(end) != 1:
        raise ValueError("Pinned frontend anchors differ")
    first, last = source.index(start), source.index(end)
    block = source[first:last]
    if first >= last or not block.endswith("  T_out=Tl; return out;\n}\n\n"):
        raise ValueError("Pinned frontend end differs")
    return block


def validate_wav(raw):
    if len(raw) < 44 or len(raw) > 960044:
        raise ValueError("Invalid WAV size")
    header = struct.unpack("<4sI4s4sIHHIIHH4sI", raw[:44])
    n = (len(raw) - 44) // 2
    expected = (b"RIFF", len(raw)-8, b"WAVE", b"fmt ", 16, 1, 1, 16000, 32000, 2, 16, b"data", n*2)
    if header != expected or len(raw) != 44+n*2 or not 400 <= n <= 480000:
        raise ValueError("Expected canonical mono16k PCM16 WAV")
    return n


def floats(raw, count):
    if len(raw) != count*4:
        raise ValueError("Float data length differs")
    values = struct.unpack(f"<{count}f", raw)
    if any(not math.isfinite(value) for value in values):
        raise ValueError("Nonfinite float data")
    return values


def validate_pcm(raw, frames):
    if type(frames) is not int or not 400 <= frames <= 480000:
        raise ValueError("Invalid trusted frame count")
    return floats(raw, frames)


def validate_feature(raw, frames):
    if type(frames) is not int or not 400 <= frames <= 480000:
        raise ValueError("Invalid trusted frame count")
    t = (((frames-400)//160+1)+5)//6
    if len(raw) != 8+t*560*4 or struct.unpack("<ii", raw[:8]) != (t, 560):
        raise ValueError("Feature length/dimensions differ")
    return floats(raw[8:], t*560)


def numeric_difference(left, right):
    if not left or len(left) != len(right):
        raise ValueError("Mismatched numerical arrays")
    differences = [abs(a-b) for a, b in zip(left, right)]
    if any(not math.isfinite(value) for value in differences):
        raise ValueError("Invalid numerical comparison")
    return {"elements": len(left), "changed": sum(d != 0 for d in differences),
            "max_abs": max(differences), "rms": math.sqrt(math.fsum(d*d for d in differences)/len(differences))}


PREAMBLE = r'''#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <limits>
#include <vector>
#define FUNASR_AUDIO_IMPLEMENTATION
#include "funasr_audio.h"
'''

MAIN = r'''
static bool write_bytes(const char* path, const char* bytes, size_t count) {
  std::ofstream output(path, std::ios::binary | std::ios::trunc);
  if (!output) return false;
  output.write(bytes, static_cast<std::streamsize>(count));
  output.close();
  return !output.fail();
}
int main(int argc, char** argv) {
  static_assert(sizeof(float)==4 && std::numeric_limits<float>::is_iec559, "IEEE754 float32 required");
  static_assert(sizeof(void*)==8, "x64 required");
  const uint32_t endian=1;
  if(argc!=4 || *reinterpret_cast<const unsigned char*>(&endian)!=1) {
    std::fprintf(stderr,"expected WAV PCM FEATURE on little-endian x64\n"); return 2;
  }
  std::vector<float> wav;
  if(!funasr_load_audio_16k_mono(argv[1],wav) || wav.size()<400 || wav.size()>480000) {
    std::fprintf(stderr,"invalid decoded audio\n"); return 3;
  }
  for(float value:wav) if(!std::isfinite(value)) {
    std::fprintf(stderr,"nonfinite audio\n"); return 3;
  }
  if(!write_bytes(argv[2],reinterpret_cast<const char*>(wav.data()),wav.size()*4)) {
    std::fprintf(stderr,"PCM write failed\n"); return 4;
  }
  int t=0;
  const auto fb=compute_fbank(wav,t);
  const int expected=(static_cast<int>((wav.size()-400)/160+1)+5)/6;
  if(t!=expected || fb.size()!=static_cast<size_t>(t)*560) {
    std::fprintf(stderr,"invalid feature dimensions\n"); return 5;
  }
  for(float value:fb) if(!std::isfinite(value)) {
    std::fprintf(stderr,"nonfinite feature\n"); return 5;
  }
  const int32_t header[2]={t,560};
  std::vector<char> bytes(8+fb.size()*4);
  std::memcpy(bytes.data(),header,8);
  std::memcpy(bytes.data()+8,fb.data(),fb.size()*4);
  if(!write_bytes(argv[3],bytes.data(),bytes.size())) {
    std::fprintf(stderr,"feature write failed\n"); return 4;
  }
  return 0;
}
'''

CMAKE = '''cmake_minimum_required(VERSION 3.16)
cmake_policy(SET CMP0091 NEW)
project(sense_feature_extractor LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY MultiThreaded)
add_executable(feature-extractor extractor.cpp)
target_include_directories(feature-extractor PRIVATE "${FUNASR_COMMON}")
if(MSVC)
  target_compile_definitions(feature-extractor PRIVATE NOMINMAX _USE_MATH_DEFINES)
  target_link_options(feature-extractor PRIVATE /MANIFEST:EMBED "/MANIFESTINPUT:${UTF8_MANIFEST}")
else()
  target_link_libraries(feature-extractor PRIVATE pthread dl m)
  target_link_options(feature-extractor PRIVATE -static-libstdc++ -static-libgcc)
endif()
'''


def generate(source, output):
    source, output = Path(source), Path(output)
    text = source.read_bytes().decode("utf-8")
    block = extract_block(text)
    output.mkdir(parents=True, exist_ok=True)
    (output / "extractor.cpp").write_text(PREAMBLE+block+MAIN, encoding="utf-8", newline="\n")
    (output / "CMakeLists.txt").write_text(CMAKE, encoding="utf-8", newline="\n")
    return {"sourceSha256": sha(source.read_bytes()), "blockSha256": sha(block.encode())}
