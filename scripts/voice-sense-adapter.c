/* CI-only Whisper CLI interface adapter; production transcriber stays unchanged. */
#define _POSIX_C_SOURCE 200809L
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include "sherpa-onnx/c-api/c-api.h"
#ifdef SEGMENT_SECONDS
#include "voice-segments.h"
#endif

int main(int argc, char **argv) {
  const char *model = NULL, *input = NULL, *output = NULL;
  for (int i = 1; i < argc; ++i) {
    if (!strcmp(argv[i], "-m") && i + 1 < argc) model = argv[++i];
    else if (!strcmp(argv[i], "-f") && i + 1 < argc) input = argv[++i];
    else if (!strcmp(argv[i], "-of") && i + 1 < argc) output = argv[++i];
    else if ((!strcmp(argv[i], "-l") || !strcmp(argv[i], "-t") ||
              !strcmp(argv[i], "-p") || !strcmp(argv[i], "-bs") ||
              !strcmp(argv[i], "-bo")) && i + 1 < argc) ++i;
    else if (strcmp(argv[i], "-otxt") && strcmp(argv[i], "-nt") &&
             strcmp(argv[i], "-np") && strcmp(argv[i], "-ng")) {
      fprintf(stderr, "Unsupported adapter argument\n");
      return 2;
    }
  }
  if (!model || !input || !output) {
    fprintf(stderr, "Expected -m model -f input -of output\n");
    return 2;
  }
  char tokens[PATH_MAX], result_path[PATH_MAX];
  const char *slash = strrchr(model, '/');
  if (!slash || snprintf(tokens, sizeof(tokens), "%.*s/tokens.txt",
      (int)(slash - model), model) >= (int)sizeof(tokens) ||
      snprintf(result_path, sizeof(result_path), "%s.txt", output) >= (int)sizeof(result_path)) {
    fprintf(stderr, "Invalid model or output path\n");
    return 2;
  }
  const SherpaOnnxWave *audio = SherpaOnnxReadWave(input);
  if (!audio || audio->sample_rate != 16000 || audio->num_samples <= 0 ||
      audio->num_samples > 480000) {
    fprintf(stderr, "Invalid bounded waveform\n");
    if (audio) SherpaOnnxFreeWave(audio);
    return 2;
  }
  SherpaOnnxOfflineRecognizerConfig config = {0};
  config.decoding_method = "greedy_search";
  config.model_config.num_threads = 1;
  config.model_config.provider = "cpu:scripts/voice-cpu-lowmem.config";
  config.model_config.tokens = tokens;
  config.model_config.sense_voice.model = model;
  config.model_config.sense_voice.language = "auto";
  config.model_config.sense_voice.use_itn = 1;
  const SherpaOnnxOfflineRecognizer *recognizer = SherpaOnnxCreateOfflineRecognizer(&config);
  if (!recognizer) {
    fprintf(stderr, "Recognizer initialization failed\n");
    SherpaOnnxFreeWave(audio);
    return 3;
  }
  char transcript[32768] = {0};
  size_t used = 0;
  int failed = 0, start = 0, count = 0;
  while (!failed && start < audio->num_samples) {
    int end = audio->num_samples;
#ifdef SEGMENT_SECONDS
    end = voice_segment_end(audio->samples, audio->num_samples, start, SEGMENT_SECONDS * 16000);
#endif
    if (end <= start || end > audio->num_samples) {
      failed = 1;
      break;
    }
    const SherpaOnnxOfflineStream *stream = SherpaOnnxCreateOfflineStream(recognizer);
    if (!stream) {
      failed = 1;
      break;
    }
    SherpaOnnxAcceptWaveformOffline(stream, 16000, audio->samples + start, end - start);
    SherpaOnnxDecodeOfflineStream(recognizer, stream);
    const SherpaOnnxOfflineRecognizerResult *result = SherpaOnnxGetOfflineStreamResult(stream);
    if (!result || !result->text || used + strlen(result->text) + 2 > sizeof(transcript)) {
      failed = 1;
    } else if (*result->text) {
      if (used) transcript[used++] = ' ';
      strcpy(transcript + used, result->text);
      used += strlen(result->text);
    }
    fprintf(stderr, "VOICE_SEGMENT start=%d end=%d\n", start, end);
    if (result) SherpaOnnxDestroyOfflineRecognizerResult(result);
    SherpaOnnxDestroyOfflineStream(stream);
    start = end;
    ++count;
  }
  struct rusage usage;
  if (getrusage(RUSAGE_SELF, &usage) != 0) failed = 1;
  if (!failed) {
    FILE *metrics = fopen("chain-evidence/native-metrics.jsonl", "a");
    if (!metrics) {
      perror("adapter metrics");
      failed = 1;
    } else {
      int write_failed = fprintf(metrics, "{\"peak_rss_kib\":%ld,\"segments\":%d}\n", usage.ru_maxrss, count) < 0;
      if (fclose(metrics) != 0 || write_failed) failed = 1;
    }
    if (usage.ru_maxrss > 384 * 1024) {
      fprintf(stderr, "Service RSS budget exceeded\n");
      failed = 1;
    }
  }
  if (!failed) {
    FILE *file = fopen(result_path, "w");
    if (!file) {
      perror("adapter transcript");
      failed = 1;
    } else {
      int write_failed = fprintf(file, "%s\n", transcript) < 0;
      if (fclose(file) != 0 || write_failed) failed = 1;
    }
  }
  SherpaOnnxDestroyOfflineRecognizer(recognizer);
  SherpaOnnxFreeWave(audio);
  if (failed) fprintf(stderr, "Recognition or bounded output failed\n");
  return failed ? 4 : 0;
}
