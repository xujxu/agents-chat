#ifndef VOICE_SEGMENTS_H
#define VOICE_SEGMENTS_H

/* Select a low-energy boundary near the limit; never remove or duplicate frames. */
static int voice_segment_end(const float *audio, int total, int start, int maximum) {
  if (!audio || start < 0 || start >= total || maximum <= 0) return -1;
  if (total - start <= maximum) return total;
  int limit = start + maximum;
  int search = maximum / 4;
  if (search > 16000) search = 16000;
  int best = limit;
  double best_energy = -1;
  for (int begin = limit - search; begin + 160 <= limit; begin += 160) {
    double energy = 0;
    for (int i = begin; i < begin + 160; ++i) energy += audio[i] * audio[i];
    if (best_energy < 0 || energy <= best_energy) {
      best_energy = energy;
      best = begin + 80;
    }
  }
  return best;
}

#endif
