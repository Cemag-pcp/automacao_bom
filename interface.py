"""
Interface Tkinter pra chamar as automações deste projeto sem precisar abrir
o Prompt de Comando manualmente. Só invoca os .bat já existentes — não
reimplementa nada deles, pra continuar em sincronia se eles mudarem:

  - "Instalar e rodar (completo)" -> instalar_e_rodar_windows.bat
    (git pull --rebase, npm install, playwright install chromium, roda
    `node bom_cemag.js` — consulta BOM completa)
  - "Rodar somente cadastro" -> rodar_somente_cadastro.bat
    (mesma preparação, roda `node bom_cemag.js --somente-cadastro`)
  - "Rodar carretas específicas" -> rodar_carretas_especificas.bat
    (mesma preparação, roda `node bom_cemag.js --carreta "X" --carreta "Y"
    ...` — um código de carreta por vez, com aspas, repetindo a flag; o
    campo de texto aceita vários códigos separados por vírgula ou quebra
    de linha, NÃO por espaço — um código sozinho pode ter espaço dentro
    dele, ex.: "FA4 FB")

Os dois .bat terminam com `pause` (esperando Enter) — pensado pra quem roda
direto no terminal conseguir ler a saída antes da janela fechar. Aqui a
saída já fica registrada no log da interface, então a thread manda um
Enter pro stdin do processo assim que ele começa (fica bufferizado no pipe
até o `pause` ler), pra ele seguir sozinho até o fim sem travar esperando
alguém apertar tecla.

Roda cada .bat num thread separado (é um processo longo: git pull, npm
install, playwright install, e a automação em si) pra não travar a
janela; o log é atualizado via fila (queue.Queue), lida periodicamente
pelo thread principal do Tkinter (widgets não são thread-safe pra escrita
direta de outro thread).

Pensado pra também rodar como .exe compilado (PyInstaller — ver
`gerar_executavel.bat`), colocado dentro desta mesma pasta, ao lado dos
.bat: `__file__` não serve pra achar a pasta certa quando compilado (num
build --onefile ele aponta pra uma pasta temporária de extração, não pra
onde o .exe está) — por isso o cálculo de BASE_DIR abaixo checa
`sys.frozen` e usa `sys.executable` nesse caso.

Ao abrir, checa se Git e Node.js estão no PATH (os .bat já checavam isso e
paravam com erro se não estivessem — comportamento visto ao vivo numa
máquina nova, 2026-09-17). Se faltar algo e o `winget` (gerenciador de
pacotes já embutido no Windows 10/11 modernos) estiver disponível,
pergunta se pode instalar automaticamente antes de deixar rodar qualquer
automação. Depois de instalar, é preciso FECHAR E ABRIR o programa de novo
— o processo já aberto não relê o PATH atualizado sozinho.
"""

import queue
import re
import shutil
import subprocess
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, scrolledtext

if getattr(sys, "frozen", False):
    # Compilado (PyInstaller) — __file__ apontaria pra pasta temporária de
    # extração do --onefile, não pra onde o .exe realmente está.
    BASE_DIR = Path(sys.executable).resolve().parent
else:
    BASE_DIR = Path(__file__).resolve().parent

FIM_DO_LOG = object()  # sentinela: sinaliza pro thread principal que terminou

AUTOMACOES = {
    "completo": {
        "bat": "instalar_e_rodar_windows.bat",
        "rotulo": "Instalar e rodar (completo)",
        "confirmacao": (
            "Isso vai atualizar o repositório (git pull), instalar dependências "
            "e rodar a automação BOM completa. Pode demorar. Confirma?"
        ),
    },
    "cadastro": {
        "bat": "rodar_somente_cadastro.bat",
        "rotulo": "Rodar somente cadastro",
        "confirmacao": (
            "Isso vai atualizar o repositório (git pull), instalar dependências "
            "e rodar a automação só com os itens do cadastro. Confirma?"
        ),
    },
}

# À parte de AUTOMACOES porque precisa de argumentos extras (os códigos de
# carreta), então tem seu próprio botão + campo de texto na interface.
BAT_CARRETAS = "rodar_carretas_especificas.bat"

# Pré-requisitos que os .bat já exigem (checam via "where") — usados aqui
# pra checar ANTES de deixar o usuário clicar em qualquer automação, e
# oferecer instalar sozinho via winget se faltar algo. npm não entra na
# lista à parte porque já vem junto do instalador do Node.js.
PREREQUISITOS = [
    {"comando": "git", "winget_id": "Git.Git", "nome": "Git"},
    {"comando": "node", "winget_id": "OpenJS.NodeJS.LTS", "nome": "Node.js"},
]


def prerequisitos_faltando() -> list:
    return [item for item in PREREQUISITOS if shutil.which(item["comando"]) is None]


def instalar_prerequisitos(itens: list, fila: queue.Queue) -> None:
    log = fila.put
    try:
        for item in itens:
            log(f"=== Instalando {item['nome']} (winget install {item['winget_id']}) ===")
            processo = subprocess.Popen(
                [
                    "winget", "install", "--id", item["winget_id"], "-e",
                    "--silent", "--accept-package-agreements", "--accept-source-agreements",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            for linha in processo.stdout:
                log(linha.rstrip("\n"))
            codigo = processo.wait()
            log(f"--- {item['nome']}: código de saída {codigo} ---")
        log("")
        log(
            "Instalação concluída. FECHE E ABRA o programa de novo — o processo já "
            "aberto não relê o PATH atualizado sozinho."
        )
    except Exception as erro:
        log(f"ERRO ao instalar pré-requisitos: {erro}")
    finally:
        fila.put(FIM_DO_LOG)


def rodar_bat(nome_bat: str, fila: queue.Queue, args_extras: list = None) -> None:
    log = fila.put
    caminho_bat = BASE_DIR / nome_bat
    log(f"=== Executando {nome_bat}{' ' + ' '.join(args_extras) if args_extras else ''} ===")
    try:
        processo = subprocess.Popen(
            ["cmd", "/c", str(caminho_bat)] + (args_extras or []),
            cwd=BASE_DIR,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            # Sem isso, uma janela de console preta abre (e fica piscando)
            # pro processo filho — a saída já vai toda pro nosso log, então
            # não precisa dela aparecendo na tela.
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        # O .bat termina com "pause" — manda um Enter de antemão (fica
        # bufferizado no pipe até o "pause" ler), pra não travar esperando
        # tecla depois que a automação já rodou.
        try:
            processo.stdin.write("\n")
            processo.stdin.flush()
        except Exception:
            pass

        for linha in processo.stdout:
            log(linha.rstrip("\n"))

        codigo = processo.wait()
        log(f"--- {nome_bat} terminou (código de saída {codigo}) ---")
    except Exception as erro:
        log(f"ERRO ao executar {nome_bat}: {erro}")
    finally:
        fila.put(FIM_DO_LOG)


class Interface:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("Automação BOM CEMAG")

        quadro = tk.Frame(root, padx=10, pady=10)
        quadro.pack(fill="both", expand=True)

        quadro_botoes = tk.Frame(quadro)
        quadro_botoes.pack(fill="x")

        self.botoes: dict[str, tk.Button] = {}
        for chave, info in AUTOMACOES.items():
            botao = tk.Button(
                quadro_botoes,
                text=info["rotulo"],
                width=28,
                command=lambda chave=chave: self.ao_clicar(chave),
            )
            botao.pack(side="left", padx=(0, 10))
            self.botoes[chave] = botao

        quadro_carretas = tk.LabelFrame(quadro, text="Rodar só carretas específicas", padx=8, pady=8)
        quadro_carretas.pack(fill="x", pady=(10, 0))

        tk.Label(quadro_carretas, text="Códigos (separe vários por vírgula ou linha — não por espaço):").pack(
            anchor="w"
        )
        self.campo_carretas = tk.Text(quadro_carretas, width=80, height=3)
        self.campo_carretas.pack(fill="x", pady=(4, 6))

        self.botao_carretas = tk.Button(
            quadro_carretas, text="Rodar carretas específicas", command=self.ao_clicar_carretas
        )
        self.botao_carretas.pack(anchor="w")
        self.botoes["carretas"] = self.botao_carretas

        self.log = scrolledtext.ScrolledText(quadro, width=100, height=26, state="disabled")
        self.log.pack(fill="both", expand=True, pady=(10, 0))

        self.fila: queue.Queue = queue.Queue()
        self.rodando = False

        # Checagem roda logo depois da janela abrir (after, não no __init__
        # direto), pra janela já aparecer na tela antes de qualquer diálogo.
        self.root.after(300, self._checar_prerequisitos_iniciais)

    def _checar_prerequisitos_iniciais(self) -> None:
        faltando = prerequisitos_faltando()
        if not faltando:
            return

        nomes = ", ".join(item["nome"] for item in faltando)
        if shutil.which("winget") is None:
            messagebox.showwarning(
                "Pré-requisitos ausentes",
                f"Não encontrei no PATH: {nomes}.\n\n"
                "Não consigo instalar sozinho nesta máquina (winget não está disponível). "
                "Instale manualmente:\n"
                "- Git: https://git-scm.com/downloads\n"
                "- Node.js (LTS): https://nodejs.org",
            )
            return

        confirmar = messagebox.askyesno(
            "Pré-requisitos ausentes",
            f"Não encontrei no PATH: {nomes}.\n\n"
            "Posso tentar instalar automaticamente via winget agora? "
            "Pode pedir permissão de administrador (UAC) durante a instalação.",
        )
        if not confirmar:
            return

        self._iniciar(
            instalar_prerequisitos, f"Instalação de pré-requisitos ({nomes})", (faltando, self.fila)
        )

    def escrever_log(self, texto: str) -> None:
        self.log.configure(state="normal")
        self.log.insert("end", texto + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    def ao_clicar(self, chave: str) -> None:
        if self.rodando:
            messagebox.showinfo("Aguarde", "Já tem uma automação rodando — espere terminar.")
            return

        info = AUTOMACOES[chave]
        if not messagebox.askyesno("Confirmar", info["confirmacao"]):
            return

        self._iniciar(rodar_bat, info["rotulo"], (info["bat"], self.fila, None))

    def ao_clicar_carretas(self) -> None:
        if self.rodando:
            messagebox.showinfo("Aguarde", "Já tem uma automação rodando — espere terminar.")
            return

        bruto = self.campo_carretas.get("1.0", "end").strip()
        # Separa por vírgula ou quebra de linha — NUNCA por espaço, porque
        # um código de carreta sozinho pode ter espaço dentro (ex. "FA4 FB").
        codigos = [c.strip() for c in re.split(r"[,\n]", bruto) if c.strip()]
        if not codigos:
            messagebox.showerror(
                "Nenhuma carreta", "Digite pelo menos um código de carreta (separe vários por vírgula)."
            )
            return

        lista_str = ", ".join(codigos)
        confirmar = messagebox.askyesno(
            "Confirmar",
            f"Isso vai atualizar o repositório, instalar dependências e rodar a automação "
            f"SÓ pra {len(codigos)} carreta(s): {lista_str}. Confirma?",
        )
        if not confirmar:
            return

        self._iniciar(rodar_bat, f"Carretas específicas ({lista_str})", (BAT_CARRETAS, self.fila, codigos))

    def _iniciar(self, funcao_alvo, rotulo: str, args: tuple) -> None:
        """`funcao_alvo` roda numa thread separada com `args` (a fila já
        deve estar incluída em `args`, na posição certa pra cada função —
        `rodar_bat` espera fila no meio, `instalar_prerequisitos` espera
        fila no final)."""
        self.rodando = True
        for botao in self.botoes.values():
            botao.config(state="disabled")

        self.log.configure(state="normal")
        self.log.delete("1.0", "end")
        self.log.configure(state="disabled")
        self.escrever_log(f"Iniciando '{rotulo}'...")

        threading.Thread(target=funcao_alvo, args=args, daemon=True).start()
        self.root.after(100, self.checar_fila)

    def checar_fila(self) -> None:
        try:
            while True:
                item = self.fila.get_nowait()
                if item is FIM_DO_LOG:
                    self.rodando = False
                    for botao in self.botoes.values():
                        botao.config(state="normal")
                    self.escrever_log("--- fim ---")
                    return
                self.escrever_log(str(item))
        except queue.Empty:
            pass
        self.root.after(100, self.checar_fila)


def main() -> None:
    root = tk.Tk()
    Interface(root)
    root.mainloop()


if __name__ == "__main__":
    main()
