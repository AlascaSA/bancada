#!/usr/bin/env python3
"""Servidor local da Bancada: arquivos estáticos + proxy da Groq.

    python3 serve.py [porta]   (padrão 8799)

A chave da Groq NÃO vai pro navegador: o navegador chama /api/groq/... e este
servidor repassa com a chave lida de ~/Library/Application Support/Bancada/config.json
(campo "groqKey") ou, na falta, da variável GROQ_KEY. No ar, o Worker do Cloudflare
faz exatamente o mesmo papel com as mesmas rotas.
"""
import http.server
import json
import re
import time
import os
import sys
import urllib.request
import urllib.error
import urllib.parse

RAIZ = os.path.dirname(os.path.abspath(__file__))
PORTA = int(sys.argv[1]) if len(sys.argv) > 1 else 8799
CONFIG = os.path.expanduser("~/Library/Application Support/Bancada/config.json")
TESTE = os.environ.get("BANCADA_TESTE") or os.path.join(RAIZ, "teste")  # brutos do modo ?teste (fora de ~/Downloads: TCC trava o listdir)

MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".ttf": "font/ttf", ".woff2": "font/woff2",
    ".svg": "image/svg+xml", ".png": "image/png", ".mp4": "video/mp4", ".md": "text/plain; charset=utf-8",
}


def chave_groq():
    try:
        with open(CONFIG, encoding="utf-8") as f:
            k = json.load(f).get("groqKey")
            if k:
                return k
    except (OSError, ValueError):
        pass
    return os.environ.get("GROQ_KEY", "")


def _metadados(d):
    f = d.get("fluxo")
    return {"id": d["id"], "nome": d.get("nome", ""), "editadoEm": d.get("editadoEm", 0), "editadoPor": d.get("editadoPor", ""), "duracao": d.get("duracao", 0), "brutos": len(d.get("brutos", [])), "midiaEm": d.get("midiaEm", 0),
            "fluxo": ({"etapa": f.get("etapa", "editor"), "pedirRender": bool(f.get("pedirRender")), "brutoId": (f.get("bruto") or {}).get("driveId", ""), "saida": bool((f.get("saida") or {}).get("driveId")), "link": f.get("link", ""), "erro": (f.get("erro") or "")[:200], "renderErro": (f.get("renderErro") or {}).get("n", 0)} if f else None),
            "feedback": len(d.get("feedback") or []) + len(d.get("reportes") or [])}


# ---- Drive (emula a Pages Function com os arquivos de token da Dublagem)
GOOGLE = os.path.expanduser("~/.claude/.google")
_tok = {"v": "", "ate": 0}


def token_drive():
    if _tok["v"] and time.time() < _tok["ate"]:
        return _tok["v"]
    t = json.load(open(os.path.join(GOOGLE, "token_dublagem.json")))
    cs = json.load(open(os.path.join(GOOGLE, "client_secret.json")))["installed"]
    dados = urllib.parse.urlencode({"client_id": t["client_id"], "client_secret": cs["client_secret"], "refresh_token": t["refresh_token"], "grant_type": "refresh_token"}).encode()
    r = json.load(urllib.request.urlopen(urllib.request.Request("https://oauth2.googleapis.com/token", data=dados), timeout=30))
    _tok["v"] = r["access_token"]; _tok["ate"] = time.time() + 3000
    return _tok["v"]


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.command, self.path.split("?")[0]))

    def _cabecalhos(self, status, tipo, tamanho):
        self.send_response(status)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(tamanho))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    # ---- projetos (emula a Pages Function em disco: <prof>/<id>.json + midia/<id>.mp4|.jpg)
    def _projetos(self, metodo):
        u = urllib.parse.urlparse(self.path)
        partes = [x for x in urllib.parse.unquote(u.path)[len("/api/projetos"):].split("/") if x]
        q = urllib.parse.parse_qs(u.query)
        prof = (q.get("professor") or [""])[0]
        raiz = os.path.join(os.path.expanduser("~/Library/Application Support/Bancada"), "projetos")
        os.makedirs(os.path.join(raiz, "midia"), exist_ok=True)
        def responde(status, corpo, mime="application/json"):
            self._cabecalhos(status, mime, len(corpo)); self.wfile.write(corpo)
        def js(obj, status=200): responde(status, json.dumps(obj).encode())
        if not partes:
            if metodo != "GET" or not re.fullmatch(r"[a-z]{2,20}", prof): return js({"erro": "professor"}, 400)
            # professor=todos → todas as pastas, com o campo professor (como a Pages Function)
            pastas = [(p, os.path.join(raiz, p)) for p in (os.listdir(raiz) if os.path.isdir(raiz) else []) if p != "midia"] if prof == "todos" else [(prof, os.path.join(raiz, prof))]
            lista = []
            for pr, pasta in pastas:
                if not os.path.isdir(pasta): continue
                for a in os.listdir(pasta):
                    if a.endswith(".json"):
                        with open(os.path.join(pasta, a), encoding="utf-8") as f: d = json.load(f)
                        lista.append(dict(_metadados(d), **({"professor": pr} if prof == "todos" else {})))
            lista.sort(key=lambda x: -x["editadoEm"])
            return js({"projetos": lista})
        pid = partes[0]
        if not re.fullmatch(r"[A-Za-z0-9]{6,40}", pid): return js({"erro": "id"}, 400)
        if len(partes) == 2 and partes[1] in ("preview", "capa"):
            arq = os.path.join(raiz, "midia", pid + (".mp4" if partes[1] == "preview" else ".jpg"))
            if metodo == "PUT":
                dados = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                with open(arq, "wb") as f: f.write(dados)
                return js({"ok": True})
            if metodo != "GET" or not os.path.exists(arq): return responde(404, b"", "text/plain")
            with open(arq, "rb") as f: dados = f.read()
            return responde(200, dados, "video/mp4" if partes[1] == "preview" else "image/jpeg")
        if len(partes) > 1: return js({"erro": "rota"}, 404)
        if metodo == "PUT":
            d = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            if not re.fullmatch(r"[a-z]{2,20}", d.get("professor", "")): return js({"erro": "professor"}, 400)
            d["id"] = pid; d["editadoEm"] = int(time.time() * 1000)
            os.makedirs(os.path.join(raiz, d["professor"]), exist_ok=True)
            with open(os.path.join(raiz, d["professor"], pid + ".json"), "w", encoding="utf-8") as f: json.dump(d, f, ensure_ascii=False)
            return js({"ok": True, "editadoEm": d["editadoEm"]})
        if not re.fullmatch(r"[a-z]{2,20}", prof): return js({"erro": "professor"}, 400)
        arq = os.path.join(raiz, prof, pid + ".json")
        if metodo == "GET":
            if not os.path.exists(arq): return js({"erro": "não existe"}, 404)
            with open(arq, "rb") as f: return responde(200, f.read())
        if metodo == "DELETE":
            for a in [arq, os.path.join(raiz, "midia", pid + ".mp4"), os.path.join(raiz, "midia", pid + ".jpg")]:
                if os.path.exists(a): os.remove(a)
            return js({"ok": True})
        return js({"erro": "método"}, 405)

    def _drive(self, metodo):
        u = urllib.parse.urlparse(self.path)
        partes = [x for x in u.path[len("/api/drive/"):].split("/") if x]
        def js(obj, status=200):
            corpo = json.dumps(obj, ensure_ascii=False).encode(); self._cabecalhos(status, MIME[".json"], len(corpo)); self.wfile.write(corpo)
        try:
            tok = token_drive()
        except Exception as e:
            return js({"erro": "Drive: " + str(e)}, 503)
        if len(partes) == 2 and partes[0] in ("arquivo", "meta") and metodo == "GET":
            fid = partes[1]
            if partes[0] == "meta":
                req = urllib.request.Request("https://www.googleapis.com/drive/v3/files/%s?fields=id,name,size,mimeType,parents&supportsAllDrives=true" % fid, headers={"Authorization": "Bearer " + tok})
                with urllib.request.urlopen(req, timeout=30) as r: return js(json.load(r))
            req = urllib.request.Request("https://www.googleapis.com/drive/v3/files/%s?alt=media&supportsAllDrives=true" % fid, headers={"Authorization": "Bearer " + tok})
            if self.headers.get("Range"): req.add_header("Range", self.headers["Range"])
            try:
                r = urllib.request.urlopen(req, timeout=600)
            except urllib.error.HTTPError as e:
                corpo = e.read(); self._cabecalhos(e.code, "text/plain", len(corpo)); self.wfile.write(corpo); return
            self.send_response(r.status)
            for k in ("Content-Type", "Content-Length", "Content-Range", "Last-Modified"):
                if r.headers.get(k): self.send_header(k, r.headers[k])
            self.send_header("Accept-Ranges", "bytes"); self.send_header("Cache-Control", "no-store"); self.end_headers()
            try:
                while True:
                    peda = r.read(1 << 20)
                    if not peda: break
                    self.wfile.write(peda)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if partes == ["entregar"] and metodo == "POST":
            b = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            raiz = os.path.join(os.path.expanduser("~/Library/Application Support/Bancada"), "projetos")
            arq = os.path.join(raiz, b.get("professor", ""), b.get("id", "") + ".json")
            if not os.path.exists(arq): return js({"erro": "projeto não existe"}, 404)
            with open(arq, encoding="utf-8") as f: d = json.load(f)
            fl = d.get("fluxo") or {}
            if not (fl.get("saida") or {}).get("driveId"): return js({"erro": "este projeto não tem vídeo editado pelo robô"}, 409)
            if fl.get("etapa") == "entregue": return js({"ok": True, "link": fl.get("link"), "repetido": True})
            if fl.get("pedirRender"): return js({"erro": "o robô ainda está renderizando as últimas mudanças"}, 409)
            destino = (fl.get("entrega") or {}).get("pastaId")
            if not destino: return js({"erro": "este projeto não tem pasta de entrega"}, 503)
            cond = "name='%s' and '%s' in parents and trashed=false" % (fl["saida"]["nome"].replace("'", "\\'"), destino)
            req = urllib.request.Request("https://www.googleapis.com/drive/v3/files?q=%s&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true" % urllib.parse.quote(cond), headers={"Authorization": "Bearer " + tok})
            with urllib.request.urlopen(req, timeout=30) as r: velhos = json.load(r).get("files", [])
            for v in velhos:
                if v["id"] != fl["saida"]["driveId"]:
                    rq = urllib.request.Request("https://www.googleapis.com/drive/v3/files/%s?supportsAllDrives=true" % v["id"], data=b'{"trashed":true}', method="PATCH", headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
                    urllib.request.urlopen(rq, timeout=30).read()
            q = {"addParents": destino, "supportsAllDrives": "true", "fields": "id,webViewLink"}
            if (fl["saida"].get("pastaId")): q["removeParents"] = fl["saida"]["pastaId"]
            req = urllib.request.Request("https://www.googleapis.com/drive/v3/files/%s?%s" % (fl["saida"]["driveId"], urllib.parse.urlencode(q)), data=b"{}", method="PATCH", headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r: mv = json.load(r)
            agora = int(time.time() * 1000); quem = str(b.get("quem", ""))[:40]
            fl.update({"etapa": "entregue", "aprovadoPor": quem, "aprovadoEm": agora, "entregueEm": agora, "link": mv.get("webViewLink") or "https://drive.google.com/file/d/%s/view" % mv["id"], "historico": (fl.get("historico") or []) + [{"quando": agora, "quem": quem, "o": "aprovado e enviado ao Drive"}]})
            d["fluxo"] = fl; d["editadoEm"] = agora
            with open(arq, "w", encoding="utf-8") as f: json.dump(d, f, ensure_ascii=False)
            return js({"ok": True, "link": fl["link"]})
        return js({"erro": "rota"}, 404)

    def _robo(self, metodo):
        # local não acorda o robô da nuvem: responde como o vigia responderia sem nada novo
        def js(obj, status=200):
            corpo = json.dumps(obj, ensure_ascii=False).encode(); self._cabecalhos(status, MIME[".json"], len(corpo)); self.wfile.write(corpo)
        if metodo == "POST": return js({"acordou": False, "motivos": [], "rodando": False, "local": True})
        return js({"rodando": False})

    def _regras(self, metodo):
        prof = urllib.parse.urlparse(self.path).path[len("/api/regras/"):].strip("/")
        def js(obj, status=200):
            corpo = json.dumps(obj, ensure_ascii=False).encode(); self._cabecalhos(status, MIME[".json"], len(corpo)); self.wfile.write(corpo)
        if not re.fullmatch(r"[a-z]{2,20}", prof): return js({"erro": "professor"}, 400)
        pasta = os.path.join(os.path.expanduser("~/Library/Application Support/Bancada"), "regras"); os.makedirs(pasta, exist_ok=True)
        arq = os.path.join(pasta, prof + ".json")
        if metodo == "PUT":
            b = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            d = {"texto": str(b.get("texto", ""))[:4000], "editadoEm": int(time.time() * 1000), "editadoPor": str(b.get("quem", ""))[:40]}
            with open(arq, "w", encoding="utf-8") as f: json.dump(d, f, ensure_ascii=False)
            return js(d)
        if os.path.exists(arq):
            with open(arq, encoding="utf-8") as f: return js(json.load(f))
        return js({"texto": "", "editadoEm": 0, "editadoPor": ""})

    def _feedback(self):
        prof = (urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("professor") or [""])[0]
        def js(obj, status=200):
            corpo = json.dumps(obj, ensure_ascii=False).encode(); self._cabecalhos(status, MIME[".json"], len(corpo)); self.wfile.write(corpo)
        if not re.fullmatch(r"[a-z]{2,20}", prof): return js({"erro": "professor"}, 400)
        pasta = os.path.join(os.path.expanduser("~/Library/Application Support/Bancada"), "projetos", prof); itens = []
        if os.path.isdir(pasta):
            for a in os.listdir(pasta):
                if not a.endswith(".json"): continue
                with open(os.path.join(pasta, a), encoding="utf-8") as f: d = json.load(f)
                brutos = d.get("brutos") or []
                nome_bruto = lambda i: brutos[i].get("nome", "") if 0 <= i < len(brutos) else ""
                for fb in d.get("feedback") or []:
                    itens.append(dict({"fonte": "corte", "projeto": d["id"], "nome": d.get("nome", ""), "bruto": nome_bruto(fb.get("clipe", 0))}, **fb))
                for rp in d.get("reportes") or []:
                    itens.append(dict({"fonte": "reporte", "projeto": d["id"], "nome": d.get("nome", ""), "bruto": nome_bruto(rp.get("clipe", 0))}, **rp))
        itens.sort(key=lambda x: -(x.get("quando") or 0))
        return js({"itens": itens})

    def _transcricao(self, metodo):
        h = urllib.parse.urlparse(self.path).path[len("/api/transcricao/"):]
        if not re.fullmatch(r"[a-f0-9]{16,64}", h):
            corpo = b'{"erro":"hash"}'; self._cabecalhos(400, MIME[".json"], len(corpo)); self.wfile.write(corpo); return
        pasta = os.path.join(os.path.expanduser("~/Library/Application Support/Bancada"), "transcricoes"); os.makedirs(pasta, exist_ok=True)
        arq = os.path.join(pasta, h + ".json")
        if metodo == "PUT":
            with open(arq, "wb") as f: f.write(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            corpo = b'{"ok":true}'; self._cabecalhos(200, MIME[".json"], len(corpo)); self.wfile.write(corpo); return
        if not os.path.exists(arq): self._cabecalhos(404, "text/plain", 0); return
        with open(arq, "rb") as f: dados = f.read()
        self._cabecalhos(200, MIME[".json"], len(dados)); self.wfile.write(dados)

    def do_PUT(self):
        if self.path.startswith("/api/regras/"): return self._regras("PUT")
        if self.path.startswith("/api/transcricao/"): return self._transcricao("PUT")
        if self.path.startswith("/api/projetos"): return self._projetos("PUT")
        self._cabecalhos(404, "text/plain", 0)

    def do_DELETE(self):
        if self.path.startswith("/api/projetos"): return self._projetos("DELETE")
        self._cabecalhos(404, "text/plain", 0)

    def do_GET(self):
        if self.path.startswith("/api/drive/"): return self._drive("GET")
        if self.path.startswith("/api/regras/"): return self._regras("GET")
        if self.path.split("?")[0] == "/api/robo": return self._robo("GET")
        if self.path.startswith("/api/feedback"): return self._feedback()
        if self.path.startswith("/api/transcricao/"): return self._transcricao("GET")
        if self.path.startswith("/api/projetos"): return self._projetos("GET")
        caminho = urllib.parse.unquote(self.path.split("?")[0])
        if caminho == "/api/estado":
            corpo = json.dumps({"groq": bool(chave_groq())}).encode()
            self._cabecalhos(200, MIME[".json"], len(corpo))
            self.wfile.write(corpo)
            return
        if caminho == "/":
            caminho = "/index.html"
        # brutos de teste (só em desenvolvimento): /teste/lista.json e /teste/<arquivo>
        if caminho.startswith("/teste/") and TESTE:
            nome = caminho[len("/teste/"):]
            if nome == "fx/lista.json":
                pasta = os.path.join(TESTE, "fx")
                arqs = sorted(a for a in os.listdir(pasta) if a.lower().endswith((".mp4", ".mov"))) if os.path.isdir(pasta) else []
                corpo = json.dumps(arqs).encode()
                self._cabecalhos(200, MIME[".json"], len(corpo))
                self.wfile.write(corpo)
                return
            if nome.startswith("fx/"):
                alvo = os.path.join(TESTE, "fx", os.path.basename(nome[3:]))
                if os.path.isfile(alvo):
                    with open(alvo, "rb") as f:
                        dados = f.read()
                    self._cabecalhos(200, "video/mp4", len(dados))
                    self.wfile.write(dados)
                    return
            if nome == "lista.json":
                arqs = sorted(a for a in os.listdir(TESTE) if a.lower().endswith((".mp4", ".mov", ".m4v")) and a != "saida.mp4")
                corpo = json.dumps(arqs).encode()
                self._cabecalhos(200, MIME[".json"], len(corpo))
                self.wfile.write(corpo)
                return
            alvo = os.path.join(TESTE, os.path.basename(nome))
            if os.path.isfile(alvo):
                with open(alvo, "rb") as f:
                    dados = f.read()
                self._cabecalhos(200, "video/mp4", len(dados))
                self.wfile.write(dados)
                return
        alvo = os.path.normpath(os.path.join(RAIZ, caminho.lstrip("/")))
        if not alvo.startswith(RAIZ) or not os.path.isfile(alvo):
            corpo = b"nao encontrado"
            self._cabecalhos(404, "text/plain", len(corpo))
            self.wfile.write(corpo)
            return
        with open(alvo, "rb") as f:
            dados = f.read()
        ext = os.path.splitext(alvo)[1].lower()
        self._cabecalhos(200, MIME.get(ext, "application/octet-stream"), len(dados))
        self.wfile.write(dados)

    def do_POST(self):
        caminho = self.path.split("?")[0]
        if caminho == "/api/robo": return self._robo("POST")
        if caminho.startswith("/api/drive/"): return self._drive("POST")
        if caminho == "/api/salvar-teste" and TESTE:
            # modo de teste: grava o MP4 exportado em teste/saida.mp4 para conferir com ffprobe
            tamanho = int(self.headers.get("Content-Length", "0"))
            dados = self.rfile.read(tamanho)
            destino = os.path.join(TESTE, "saida.mp4")
            with open(destino, "wb") as f:
                f.write(dados)
            corpo = json.dumps({"ok": True, "bytes": len(dados), "arquivo": destino}).encode()
            self._cabecalhos(200, MIME[".json"], len(corpo))
            self.wfile.write(corpo)
            return
        if not caminho.startswith("/api/groq/"):
            corpo = b"rota desconhecida"
            self._cabecalhos(404, "text/plain", len(corpo))
            self.wfile.write(corpo)
            return
        chave = chave_groq()
        if not chave:
            corpo = json.dumps({"erro": "sem chave da Groq no servidor"}).encode()
            self._cabecalhos(503, MIME[".json"], len(corpo))
            self.wfile.write(corpo)
            return
        tamanho = int(self.headers.get("Content-Length", "0"))
        dados = self.rfile.read(tamanho)
        destino = "https://api.groq.com/openai/v1/" + caminho[len("/api/groq/"):]
        req = urllib.request.Request(destino, data=dados, method="POST")
        req.add_header("Authorization", "Bearer " + chave)
        req.add_header("Content-Type", self.headers.get("Content-Type", "application/octet-stream"))
        req.add_header("User-Agent", "Bancada/1.0")
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                corpo = r.read()
                self._cabecalhos(r.status, r.headers.get("Content-Type", MIME[".json"]), len(corpo))
                self.wfile.write(corpo)
        except urllib.error.HTTPError as e:
            corpo = e.read()
            self._cabecalhos(e.code, e.headers.get("Content-Type", MIME[".json"]), len(corpo))
            self.wfile.write(corpo)
        except Exception as e:  # rede fora
            corpo = json.dumps({"erro": str(e)}).encode()
            self._cabecalhos(502, MIME[".json"], len(corpo))
            self.wfile.write(corpo)


if __name__ == "__main__":
    print("Bancada em http://localhost:%d  (chave Groq: %s)" % (PORTA, "ok" if chave_groq() else "FALTA"))
    http.server.ThreadingHTTPServer(("127.0.0.1", PORTA), H).serve_forever()
