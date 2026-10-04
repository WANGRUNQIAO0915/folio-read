"""Optional source-content review; stored notes remain recoverable when hidden."""
from . import config


def for_reader(discussion: dict) -> dict:
    if config.load().get('source_checks', False):
        return discussion
    return {**discussion, 'entries': [e for e in discussion.get('entries', []) if e.get('kind') != 'check']}
