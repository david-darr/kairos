"""Owned system-temp fixtures with explicit Windows handle cleanup."""
import atexit
import logging
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import time
from unittest.mock import patch


class TestDataDirectory:
    def __init__(self, prefix):
        # Python 3.12's Windows 0700 ACL denies this restricted test token.
        # Keep inherited ACLs, including when the parent is system temp.
        mkdir = os.mkdir
        with patch('tempfile._os.mkdir', side_effect=lambda path, mode=0o777:
                   mkdir(path, 0o777 if os.name == 'nt' else mode)):
            self.name = tempfile.mkdtemp(prefix=prefix)
        atexit.register(self.cleanup)

    def cleanup(self):
        root = Path(self.name).resolve()
        if not root.exists():
            atexit.unregister(self.cleanup)
            return
        store = sys.modules.get('core.session_manager_store')
        if store and Path(store.DB_FILE).resolve().is_relative_to(root):
            store.close()
        registry = sys.modules.get('core.chat_tasks')
        if registry and Path(registry.DATA_DIR).resolve().is_relative_to(root):
            registry.set_listener(None)
            for timer in registry._pending.values():
                timer.cancel()
            registry._pending.clear()
            registry._sessions.clear()
            registry._notified.clear()
        loggers = [logging.getLogger()] + [value for value in logging.Logger.manager.loggerDict.values()
                                         if isinstance(value, logging.Logger)]
        for logger in loggers:
            for handler in logger.handlers[:]:
                filename = getattr(handler, 'baseFilename', None)
                if filename and Path(filename).resolve().is_relative_to(root):
                    logger.removeHandler(handler)
                    handler.close()

        def writable(function, path, error):
            if not isinstance(error, PermissionError):
                raise error
            os.chmod(path, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
            function(path)

        for attempt in range(5):
            try:
                shutil.rmtree(root, onexc=writable)
                break
            except FileNotFoundError:
                break
            except OSError as error:
                if attempt == 4:
                    print(f'WARNING: could not remove test data {root}: {error}', file=sys.stderr)
                else:
                    time.sleep(.05 * (attempt + 1))
        atexit.unregister(self.cleanup)
