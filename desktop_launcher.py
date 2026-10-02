"""Entry point for the standalone Windows application."""
import multiprocessing
import logging
import os
import sys

from easyread.desktop import main

if __name__ == '__main__':
    multiprocessing.freeze_support()
    result = main()
    logging.shutdown()
    # Shutdown has saved interruption states. Remote API workers must not leave
    # the frozen app invisibly alive after its last window closes.
    if getattr(sys, 'frozen', False):
        os._exit(result)
    raise SystemExit(result)
