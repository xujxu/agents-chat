#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <unistd.h>

#define MIB (1024UL * 1024UL)
#define VISIBLE __attribute__((noinline, visibility("default")))

static void *checked(void *pointer, size_t size)
{
    if (!pointer) {
        perror("fixture allocation");
        exit(2);
    }
    memset(pointer, 1, size);
    return pointer;
}

VISIBLE void *cpg_probe_release(void)
{
    return checked(malloc(32 * MIB), 32 * MIB);
}

VISIBLE void *cpg_probe_keep(void)
{
    return checked(malloc(16 * MIB), 16 * MIB);
}

VISIBLE void *cpg_probe_resize(void)
{
    void *pointer = checked(malloc(8 * MIB), 8 * MIB);
    volatile size_t impossible = SIZE_MAX - 4095;
    errno = 0;
    void *failed = realloc(pointer, impossible);
    if (failed || errno != ENOMEM) {
        fputs("Expected failed realloc preserving original allocation\n", stderr);
        exit(3);
    }
    return checked(realloc(pointer, 24 * MIB), 24 * MIB);
}

VISIBLE void *cpg_probe_worker(void *unused)
{
    (void)unused;
    return checked(calloc(8, MIB), 8 * MIB);
}

int main(int argc, char **argv)
{
    int abrupt = argc == 2 && strcmp(argv[1], "kill") == 0;
    pthread_t thread;
    void *worker = NULL;
    if (pthread_create(&thread, NULL, cpg_probe_worker, NULL)
        || pthread_join(thread, &worker)) {
        fputs("Fixture worker failed\n", stderr);
        return 4;
    }
    void *released = cpg_probe_release();
    void *retained = cpg_probe_keep();
    void *resized = cpg_probe_resize();
    void *mapping = mmap(NULL, 12 * MIB, PROT_READ | PROT_WRITE,
                         MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (mapping == MAP_FAILED) {
        perror("fixture mmap");
        return 5;
    }
    memset(mapping, 1, 12 * MIB);
    sleep(2);
    free(released);
    free(resized);
    free(worker);
    if (munmap(mapping, 12 * MIB)) {
        perror("fixture munmap");
        return 6;
    }
    sleep(2);
    struct rusage usage;
    if (getrusage(RUSAGE_SELF, &usage)) {
        perror("fixture getrusage");
        return 7;
    }
    printf("CPG_PROBE {\"max_rss_bytes\":%ld,\"retained_bytes\":%lu,"
           "\"direct_mmap_bytes\":%lu,\"check\":%d}\n",
           usage.ru_maxrss * 1024, 16 * MIB, 12 * MIB, *(unsigned char *)retained);
    fflush(stdout);
    if (abrupt)
        raise(SIGKILL);
    /* Deliberately outstanding: this is a known fixture, not a leak detector. */
    return 0;
}
