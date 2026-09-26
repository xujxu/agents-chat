"""Bounded CI adaptation of the pinned upstream SenseVoice CLI, not a new decoder."""

import difflib
from pathlib import Path
import sys


def patch(source):
    replacements = (
        ("#include <cstring>", "#include <cstring>\n#include <cstdlib>"),
        ('  std::string backend_name="cpu";',
         '  std::string backend_name="cpu";\n  int n_threads=8;'),
        ('    else if(!strcmp(argv[i],"--backend")&&i+1<argc)backend_name=argv[++i];',
         '''    else if(!strcmp(argv[i],"--threads")&&i+1<argc){
      const char *value=argv[++i];
      if(strcmp(value,"1")&&strcmp(value,"2")&&strcmp(value,"4")){
        fprintf(stderr,"threads must be 1, 2 or 4\\n"); return 2;
      }
      n_threads=value[0]-'0';
    }
    else if(!strcmp(argv[i],"--backend")&&i+1<argc)backend_name=argv[++i];'''),
        ("  graph_backend graph_be=make_graph_backend(backend_name);",
         '  fprintf(stderr,"VOICE_THREADS=%d\\n",n_threads);\n'
         "  graph_backend graph_be=make_graph_backend(backend_name);"),
        ("ggml_backend_cpu_set_n_threads(graph_be.backend,8);",
         "ggml_backend_cpu_set_n_threads(graph_be.backend,n_threads);"),
        ('if(compute_status!=GGML_STATUS_SUCCESS){fprintf(stderr,"compute failed\\n");}',
         'if(compute_status!=GGML_STATUS_SUCCESS){fprintf(stderr,"compute failed\\n"); std::exit(3);}'),
    )
    for old, new in replacements:
        if source.count(old) != 1:
            raise ValueError("Pinned native source contract changed")
        source = source.replace(old, new, 1)
    return source


if __name__ == "__main__":
    source, evidence = map(Path, sys.argv[1:])
    original = source.read_text(encoding="utf-8")
    modified = patch(original)
    evidence.write_text("".join(difflib.unified_diff(
        original.splitlines(keepends=True), modified.splitlines(keepends=True),
        fromfile="upstream/funasr-sensevoice.cpp", tofile="bounded/funasr-sensevoice.cpp")),
        encoding="utf-8", newline="\n")
    source.write_text(modified, encoding="utf-8", newline="\n")
