/* CI-only probe using the sherpa-onnx v1.13.8 public C API. */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include "sherpa-onnx/c-api/c-api.h"

static double seconds(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
    perror("clock_gettime");
    exit(1);
  }
  return now.tv_sec + now.tv_nsec / 1e9;
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "Usage: voice-vad-probe sample.wav\n");
    return 1;
  }
  const SherpaOnnxWave *audio = SherpaOnnxReadWave(argv[1]);
  if (!audio || audio->sample_rate != 16000 || audio->num_samples <= 0 ||
      audio->num_samples > 480000) {
    fprintf(stderr, "Expected nonempty mono 16kHz audio, at most 30 seconds\n");
    if (audio) SherpaOnnxFreeWave(audio);
    return 1;
  }
  double start = seconds();
  SherpaOnnxVadModelConfig vc = {0};
  vc.silero_vad.model = "silero_vad.onnx";
  vc.silero_vad.threshold = 0.5f;
  vc.silero_vad.min_silence_duration = 0.3f;
  vc.silero_vad.min_speech_duration = 0.2f;
  vc.silero_vad.max_speech_duration = 10.0f;
  vc.silero_vad.window_size = 512;
  vc.sample_rate = 16000;
  vc.num_threads = 1;
  vc.provider = "cpu";
  const SherpaOnnxVoiceActivityDetector *vad =
      SherpaOnnxCreateVoiceActivityDetector(&vc, 31);
  if (!vad) {
    fprintf(stderr, "VAD initialization failed\n");
    SherpaOnnxFreeWave(audio);
    return 1;
  }
  for (int offset = 0; offset < audio->num_samples; offset += 512) {
    int remaining = audio->num_samples - offset;
    if (remaining >= 512) {
      SherpaOnnxVoiceActivityDetectorAcceptWaveform(vad, audio->samples + offset, 512);
    } else {
      float tail[512] = {0};
      for (int i = 0; i < remaining; ++i) tail[i] = audio->samples[offset + i];
      SherpaOnnxVoiceActivityDetectorAcceptWaveform(vad, tail, 512);
    }
  }
  SherpaOnnxVoiceActivityDetectorFlush(vad);
  double vad_seconds = seconds() - start;
  double load_seconds = 0, decode_seconds = 0;
  int count = 0, failed = 0;
  const SherpaOnnxOfflineRecognizer *recognizer = NULL;
  if (!SherpaOnnxVoiceActivityDetectorEmpty(vad)) {
    SherpaOnnxOfflineRecognizerConfig rc = {0};
    rc.decoding_method = "greedy_search";
    rc.model_config.num_threads = 1;
    rc.model_config.provider = "cpu";
    rc.model_config.tokens = "sense/tokens.txt";
    rc.model_config.sense_voice.model = "sense/model.int8.onnx";
    rc.model_config.sense_voice.language = "auto";
    rc.model_config.sense_voice.use_itn = 1;
    start = seconds();
    recognizer = SherpaOnnxCreateOfflineRecognizer(&rc);
    load_seconds = seconds() - start;
    if (!recognizer) {
      fprintf(stderr, "Recognizer initialization failed\n");
      failed = 1;
    }
  }
  while (!failed && !SherpaOnnxVoiceActivityDetectorEmpty(vad)) {
    const SherpaOnnxSpeechSegment *segment = SherpaOnnxVoiceActivityDetectorFront(vad);
    const SherpaOnnxOfflineStream *stream = SherpaOnnxCreateOfflineStream(recognizer);
    if (!segment || !stream) {
      fprintf(stderr, "Segment/stream allocation failed\n");
      if (segment) SherpaOnnxDestroySpeechSegment(segment);
      if (stream) SherpaOnnxDestroyOfflineStream(stream);
      failed = 1;
      break;
    }
    start = seconds();
    SherpaOnnxAcceptWaveformOffline(stream, 16000, segment->samples, segment->n);
    SherpaOnnxDecodeOfflineStream(recognizer, stream);
    const SherpaOnnxOfflineRecognizerResult *result = SherpaOnnxGetOfflineStreamResult(stream);
    decode_seconds += seconds() - start;
    if (!result || !result->json) {
      fprintf(stderr, "Missing recognition result\n");
      failed = 1;
    } else {
      printf("{\"segment_start\":%.4f,\"segment_end\":%.4f,\"result\":%s}\n",
             segment->start / 16000.0, (segment->start + segment->n) / 16000.0,
             result->json);
      ++count;
    }
    if (result) SherpaOnnxDestroyOfflineRecognizerResult(result);
    SherpaOnnxDestroyOfflineStream(stream);
    SherpaOnnxDestroySpeechSegment(segment);
    SherpaOnnxVoiceActivityDetectorPop(vad);
  }
  printf("{\"segments\":%d,\"vad_seconds\":%.4f,\"load_seconds\":%.4f,\"decode_seconds\":%.4f}\n",
         count, vad_seconds, load_seconds, decode_seconds);
  if (recognizer) SherpaOnnxDestroyOfflineRecognizer(recognizer);
  SherpaOnnxDestroyVoiceActivityDetector(vad);
  SherpaOnnxFreeWave(audio);
  return failed;
}
