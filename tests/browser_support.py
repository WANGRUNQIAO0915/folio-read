"""Synthetic PDF and network-disabled server for the Chromium regression test.

The server runs the installed application from a temporary working directory.
Only the test harness is changed: application routes, jobs, and storage are real.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


TITLE = "Folio Offline Regression Fixture"


def fixture(destination: Path) -> None:
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    writer = PdfWriter()
    font = DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"),
    })
    for number in (1, 2):
        page = writer.add_blank_page(width=612, height=792)
        page[NameObject("/Resources")] = DictionaryObject({
            NameObject("/Font"): DictionaryObject({NameObject("/F1"): font}),
        })
        stream = DecodedStreamObject()
        stream.set_data((
            f"BT /F1 20 Tf 50 720 Td ({TITLE}) Tj "
            f"0 -40 Td /F1 14 Tf (Synthetic page {number}. No external services.) Tj ET"
        ).encode("ascii"))
        # PDF content streams must be indirect objects. Assigning the stream
        # directly is tolerated by pypdf but ignored by PDFium (blank pages).
        page.replace_contents(stream)
    writer.add_metadata({"/Title": TITLE, "/Author": "Folio CI synthetic fixture"})
    with destination.open("wb") as output:
        writer.write(output)


def serve(guard_log: Path) -> None:
    def offline_guard(event, args):
        if event not in ("socket.connect", "subprocess.Popen"):
            return
        # No outbound sockets or model CLI subprocesses can run in this server.
        # The application's harmless Ollama discovery probe is blocked too.
        target = args[1] if event == "socket.connect" else str(args[0])
        with guard_log.open("a", encoding="utf-8") as output:
            output.write(json.dumps({"event": event, "target": target}) + "\n")
        raise RuntimeError("Outbound connections and subprocesses are disabled in browser CI")

    sys.addaudithook(offline_guard)
    from easyread.server import serve as serve_application

    serve_application(port=0, open_browser=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("fixture", "serve"))
    parser.add_argument("path", type=Path)
    arguments = parser.parse_args()
    if arguments.mode == "fixture":
        fixture(arguments.path)
    else:
        serve(arguments.path)
