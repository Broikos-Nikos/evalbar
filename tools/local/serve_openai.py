"""
A minimal OpenAI-compatible chat endpoint for one local model, so that the
committed runs of the SQL suite can be made again on this kind of machine.

    python -I tools/local/serve_openai.py --model Qwen/Qwen2.5-Coder-1.5B-Instruct --revision 2e1fd397ee46e1388853d2af2c993145b0f1098a --port 8977

It is not part of evalbar. evalbar's openai provider talks to any server that
speaks this protocol, and llama.cpp's server, LM Studio and vLLM are what a
user would point it at; this exists so that a reader can reproduce the runs
in examples/sql-refusals/runs with torch and transformers alone.

One request at a time. Greedy decoding at temperature 0 or when none is sent,
sampling with the request's seed otherwise. Usage is counted from the token
ids, not estimated: prompt_tokens is the templated prompt's length and
completion_tokens the new tokens. finish_reason is "length" when generation
stopped at max_tokens. The model name in every response carries the revision,
so a run records which weights answered it.
"""
import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")

import torch  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--model", required=True)
ap.add_argument("--revision", required=True)
ap.add_argument("--port", type=int, default=8977)
args = ap.parse_args()

tok = AutoTokenizer.from_pretrained(args.model, revision=args.revision)
# loaded, then moved: device_map would need accelerate, one more package for one line
model = AutoModelForCausalLM.from_pretrained(args.model, revision=args.revision, dtype=torch.bfloat16).to("cuda")
model.eval()
NAME = f"{args.model}@{args.revision[:7]}"


def complete(body):
    messages = body["messages"]
    max_tokens = int(body.get("max_tokens") or 256)
    temperature = float(body.get("temperature") or 0)
    prompt = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    enc = tok(prompt, return_tensors="pt").to(model.device)
    gen = {"max_new_tokens": max_tokens, "pad_token_id": tok.eos_token_id}
    if temperature > 0:
        torch.manual_seed(int(body.get("seed") or 0))
        gen.update(do_sample=True, temperature=temperature)
    else:
        gen.update(do_sample=False, temperature=None, top_p=None, top_k=None)
    with torch.no_grad():
        out = model.generate(**enc, **gen)
    new = out[0, enc["input_ids"].shape[1]:]
    text = tok.decode(new, skip_special_tokens=True)
    stopped = int(new[-1]) in {tok.eos_token_id, *(model.generation_config.eos_token_id if isinstance(model.generation_config.eos_token_id, list) else [model.generation_config.eos_token_id])}
    return {
        "model": NAME,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop" if stopped or len(new) < max_tokens else "length"}],
        "usage": {"prompt_tokens": int(enc["input_ids"].shape[1]), "completion_tokens": int(len(new))},
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.send(200 if self.path == "/health" else 404, {"model": NAME} if self.path == "/health" else {"error": "not found"})

    def do_POST(self):
        if not self.path.endswith("/chat/completions"):
            return self.send(404, {"error": {"message": f"no route {self.path}"}})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))).decode("utf-8"))
            self.send(200, complete(body))
        except Exception as e:  # a bad request is the client's error, reported as JSON, and the server stays up
            self.send(400, {"error": {"message": f"{type(e).__name__}: {e}"}})


print(f"serving {NAME} on http://127.0.0.1:{args.port}/v1", flush=True)
HTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
