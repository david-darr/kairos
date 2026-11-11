"""Junctions and symbolic links inside the data folder are never followed (2026-11-10, found by the 2.3.0
upgrade rehearsal on a copy of David's profile).

A folder in the data folder can be a link to somewhere else: three snapshot folders under generated_files hold
Windows junctions to an outside project's node_modules. os.path.islink() is False for a junction, so os.walk,
shutil.copytree and the backup walker all went through them: the backup packed 2.18 GB of someone else's
files, and opening that many files through junctions under AppData\\Roaming leaks kernel memory on this kind of
machine. Every walk of the data folder that matters (backups, the account migration and its safety copy) uses
walk() here, which lists a link as a link and never enters it. A backup records each link by its target and a
restore makes it again (core/backup.py).

A link is a symbolic link or a name-surrogate reparse point (junctions, mount points, directory symlinks).
Other reparse points (OneDrive placeholders, deduplicated files) are ordinary files and folders with content.
"""
import os
import stat
from typing import Iterator, Optional

REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
NAME_SURROGATE = 0x20000000   # the reparse-tag bit Windows sets on every tag that names another place
MOUNT_POINT = 0xA0000003      # IO_REPARSE_TAG_MOUNT_POINT: a junction


def _lstat(item):
    return item.stat(follow_symlinks=False) if isinstance(item, os.DirEntry) else os.lstat(item)


def is_link(item) -> bool:
    """Whether a path (or os.DirEntry) is a symlink or junction. Missing paths are not links."""
    try:
        info = _lstat(item)
    except OSError:
        return False
    if stat.S_ISLNK(info.st_mode):
        return True
    return bool(getattr(info, "st_file_attributes", 0) & REPARSE_POINT) and \
        bool(getattr(info, "st_reparse_tag", 0) & NAME_SURROGATE)


def kind(path: str) -> str:
    """"junction" or "symlink" for a link."""
    try:
        return "junction" if getattr(os.lstat(path), "st_reparse_tag", 0) == MOUNT_POINT else "symlink"
    except OSError:
        return "symlink"


def target(path: str) -> Optional[str]:
    """Where a link points, without following it; None when it can't be read."""
    try:
        found = os.readlink(path)
    except (OSError, ValueError):
        return None
    for prefix in ("\\\\?\\UNC\\", "\\??\\UNC\\"):
        if found.startswith(prefix):
            return "\\\\" + found[len(prefix):]
    for prefix in ("\\\\?\\", "\\??\\"):
        if found.startswith(prefix):
            return found[len(prefix):]
    return found


def make(path: str, to: str, link_kind: str = "junction") -> None:
    """Make a link at path pointing at to: a junction (Windows, folders) or a symlink."""
    if link_kind == "junction" and os.name == "nt":
        import _winapi
        _winapi.CreateJunction(to, path)
    else:
        os.symlink(to, path, target_is_directory=os.path.isdir(to))


def remove(path: str) -> None:
    """Remove the link itself, never what it points at."""
    if os.name == "nt" and os.path.isdir(path):
        os.rmdir(path)  # a junction or directory symlink: removes the link only
    else:
        os.unlink(path)


def walk(top: str) -> Iterator[tuple]:
    """Like os.walk(top) from the top down, but yields (folder, dirs, files, links) and never enters a link:
    links are listed by name in links, whatever they point at. dirs can be pruned in place, as with os.walk.
    Folders that can't be listed are skipped, like os.walk's default."""
    stack = [top]
    while stack:
        folder = stack.pop()
        dirs, files, links = [], [], []
        try:
            with os.scandir(folder) as entries:
                for entry in entries:
                    if is_link(entry):
                        links.append(entry.name)
                    elif entry.is_dir(follow_symlinks=False):
                        dirs.append(entry.name)
                    else:
                        files.append(entry.name)
        except OSError:
            continue
        dirs.sort()
        files.sort()
        links.sort()
        yield folder, dirs, files, links
        stack.extend(os.path.join(folder, name) for name in reversed(dirs))
