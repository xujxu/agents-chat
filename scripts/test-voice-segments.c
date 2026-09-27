#include <assert.h>
#include <stdio.h>
#include "voice-segments.h"

int main(void) {
  float audio[16000] = {0};
  for (int i = 0; i < 16000; ++i) audio[i] = 0.5f;
  for (int i = 8500; i < 8660; ++i) audio[i] = 0;
  int end = voice_segment_end(audio, 16000, 0, 10000);
  assert(end >= 8500 && end <= 8660);
  int start = 0, segments = 0;
  while (start < 16000) {
    end = voice_segment_end(audio, 16000, start, 3000);
    assert(end > start && end <= 16000 && end - start <= 3000);
    start = end;
    ++segments;
  }
  assert(start == 16000 && segments >= 6);
  assert(voice_segment_end(audio, 16000, 15999, 3000) == 16000);
  assert(voice_segment_end(audio, 16000, 0, 16000) == 16000);
  assert(voice_segment_end(audio, 16000, 0, 0) == -1);
  assert(voice_segment_end(audio, 16000, -1, 3000) == -1);
  puts("Contiguous segments cover all frames exactly once, with bounded length.");
  return 0;
}
