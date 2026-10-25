"""Build the public copy of Warsaw Downtown as one snapshot commit, from this private repo's tree.

usage:
  python tools/publish/make_public_snapshot.py --out DIR [--ref HEAD] [--message MSG] [--dry-run]

What it does:
  1. Exports the tree at --ref (`git archive`: tracked files only, no history, no untracked or ignored files).
  2. Rewrites the README for the public copy: the trailer release lives only in the private repo, so the teaser
     GIF stays as a plain image and the links to the private release are removed. It fails if the README no
     longer has the shape it expects, or if any link to the private repo remains anywhere.
  3. Scans every text file for credentials and private data (personal email, tailnet names, LAN addresses
     outside tests, employer references) and fails on a hit.
  4. Replaces the contents of --out (a git repo for the PUBLIC project; created if missing) with the export and
     commits it as one snapshot with the noreply author. It refuses an --out that overlaps the private repo,
     shares its git directory, points its origin at it, or holds any commit from its history or by anyone else,
     so the public history can only ever contain public snapshots.
--ref takes any tree-ish, so `--ref $(git write-tree)` checks the staged tree before it is committed.
It never pushes. Review `git -C DIR show --stat`, then push it yourself.
Exit 0 = snapshot committed (or nothing changed), 1 = refused (scan or README check), 2 = usage.
"""
import argparse
import datetime
import io
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

PRIVATE_SLUG = "KiranMohan-92/warsaw-downtown"
AUTHOR = ("Kiran Mohan", "KiranMohan-92@users.noreply.github.com")

TEASER_LINK = re.compile(
    r'<a href="https://github\.com/KiranMohan-92/warsaw-downtown/releases/tag/[^"]*">(<img [^>]*>)</a>')
RELEASE_DOWNLOAD_LINE = re.compile(r"^.*github\.com/KiranMohan-92/warsaw-downtown/releases/download/.*\n?", re.M)
# any spelling of a link to the private repo: https, ssh (git@github.com:...), any letter case
PRIVATE_REF = re.compile(r"github\.com[:/]+KiranMohan-92/warsaw-downtown(?![-\w])", re.I)

BLOCK = {
    "credential": re.compile(
        r"AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}"
        r"|xox[abpr]-[A-Za-z0-9-]{10,}|-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"
        # key = "value", key: 'value', "key": "value" (JSON), with a long value
        r"|(?i:(?:api[_-]?key|secret|passw(?:or)?d|token|auth[_-]?(?:key|token)|authorization)\w*['\"]?\s*[=:]\s*"
        r"['\"][^'\"\s]{12,}['\"])"
        # HTTP auth headers carry a scheme and a space: "Authorization: Bearer xyz", "Basic xyz"
        r"|(?i:\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{16,})"),
    "personal email": re.compile(r"[\w.+-]+@(?:gmail|googlemail|outlook|hotmail|icloud|proton|yahoo)\.\w+", re.I),
    "tailnet name": re.compile(r"\b[\w-]+\.ts\.net\b", re.I),
    "LAN address": re.compile(
        r"\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b"),
    "employer reference": re.compile(r"\bING(?: Hubs| Bank| Group)?\b"),
}
# Example LAN addresses are fine inside tests (synthetic fixtures). Nothing else is exempt.
ALLOW = {"LAN address": re.compile(r"\.test\.[cm]?[jt]sx?$|(^|/)test_[^/]*\.py$")}


def export(repo, ref, dest):
    data = subprocess.run(["git", "-C", repo, "archive", "--format=tar", ref], capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        tar.extractall(dest, filter="data")


def rewrite_readme(text):
    text, n_teaser = TEASER_LINK.subn(r"\1", text)
    text, n_downloads = RELEASE_DOWNLOAD_LINE.subn("", text)
    if n_teaser != 1 or n_downloads != 2:
        raise ValueError(f"README changed shape (teaser links {n_teaser}/1, release download lines {n_downloads}/2): "
                         "update rewrite_readme before publishing")
    return re.sub(r"\n{3,}", "\n\n", text)


def is_text(path):
    try:
        return b"\0" not in path.read_bytes()[:8192]
    except OSError:
        return False


def scan(root):
    hits = []
    for p in sorted(root.rglob("*")):
        if not p.is_file() or not is_text(p):
            continue
        rel = p.relative_to(root).as_posix()
        text = p.read_text(encoding="utf-8", errors="replace")
        if PRIVATE_REF.search(text):
            hits.append(f"{rel}: link to the private repo")
        for kind, rx in BLOCK.items():
            if kind in ALLOW and ALLOW[kind].search(rel):
                continue
            for i, line in enumerate(text.splitlines(), 1):
                if rx.search(line):
                    hits.append(f"{rel}:{i}: {kind}")
    return hits


def git(cwd, *args, env=None):
    return subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, env=env)


def destination_problem(repo, out):
    """Why --out must not be used, or None. The public repo has to be a separate repository whose history
    contains only public snapshots: never the private repo, a clone of it, or a worktree of it."""
    repo = Path(repo).resolve()
    if out == repo or repo in out.parents or out in repo.parents:
        return f"{out} overlaps the private repo {repo}"
    if not out.exists():
        return None
    if not (out / ".git").exists():
        return f"{out} exists and is not a git repository"
    # every inspection must succeed: a check that can't run refuses, it never passes by default
    common = git(out, "rev-parse", "--path-format=absolute", "--git-common-dir")
    private_common = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if common.returncode != 0 or private_common.returncode != 0:
        return f"cannot inspect {out} or the private repo with git ({(common.stderr or private_common.stderr).strip()})"
    if Path(common.stdout.strip()).resolve() == Path(private_common.stdout.strip()).resolve():
        return f"{out} shares its git directory with the private repo (a worktree of it)"
    remote = git(out, "remote", "get-url", "origin").stdout.strip()  # exits 2 when there's no origin: fine
    if re.search(re.escape(PRIVATE_SLUG) + r"(?:\.git)?/?$", remote, re.I):
        return f"{out}'s origin is the private repo ({remote})"
    commits = git(out, "rev-list", "--all")
    authors = git(out, "log", "--all", "--format=%ae")
    if commits.returncode != 0 or authors.returncode != 0 and commits.stdout.strip():
        return f"cannot read {out}'s history ({(commits.stderr or authors.stderr).strip()})"
    in_private = [c for c in commits.stdout.split() if git(repo, "cat-file", "-e", f"{c}^{{commit}}").returncode == 0]
    if in_private:
        return f"{out} contains {len(in_private)} commit(s) from the private history (a clone?): start from a fresh repo"
    if any(email != AUTHOR[1] for email in authors.stdout.split()):
        return f"{out} has commits by other authors: its history must contain only public snapshots"
    return None


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--ref", default="HEAD")
    ap.add_argument("--repo", default=".")
    ap.add_argument("--message")
    ap.add_argument("--dry-run", action="store_true")
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    out = Path(a.out).resolve()
    problem = destination_problem(a.repo, out)
    if problem:
        print(f"REFUSED: {problem}")
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        tree = Path(tmp) / "tree"
        tree.mkdir()
        try:
            export(a.repo, a.ref, tree)
        except subprocess.CalledProcessError as e:
            print(f"usage: cannot export {a.ref} from {a.repo}: {e.stderr.decode(errors='replace').strip()}",
                  file=sys.stderr)
            return 2
        readme = tree / "README.md"
        try:
            readme.write_text(rewrite_readme(readme.read_text(encoding="utf-8")), encoding="utf-8", newline="")
        except (OSError, ValueError) as e:
            print(f"REFUSED: {e}")
            return 1
        hits = scan(tree)
        if hits:
            print("REFUSED: private data or credentials in the export:\n  " + "\n  ".join(hits[:40]))
            return 1
        print(f"scan clean: {sum(1 for p in tree.rglob('*') if p.is_file())} files")
        if a.dry_run:
            print("OK (dry run): nothing written")
            return 0
        if not out.exists():
            out.mkdir(parents=True)
            git(out, "init", "-q", "-b", "main")
        for child in out.iterdir():
            if child.name == ".git":
                continue
            shutil.rmtree(child) if child.is_dir() and not child.is_symlink() else child.unlink()
        for child in tree.iterdir():
            dest = out / child.name
            shutil.copytree(child, dest, symlinks=True) if child.is_dir() else shutil.copy2(child, dest)
    if git(out, "add", "-A").returncode != 0:
        print("REFUSED: git add failed")
        return 1
    if git(out, "diff", "--cached", "--quiet").returncode == 0:
        print("nothing changed since the last public snapshot")
        return 0
    env = dict(os.environ, GIT_AUTHOR_NAME=AUTHOR[0], GIT_AUTHOR_EMAIL=AUTHOR[1],
               GIT_COMMITTER_NAME=AUTHOR[0], GIT_COMMITTER_EMAIL=AUTHOR[1])
    msg = a.message or f"Warsaw Downtown public snapshot ({datetime.date.today().isoformat()})"
    r = git(out, "commit", "-q", "-m", msg, env=env)
    if r.returncode != 0:
        print(f"REFUSED: commit failed: {r.stderr.strip()}")
        return 1
    print(f"COMMITTED {git(out, 'rev-parse', '--short', 'HEAD').stdout.strip()} in {out}. Review it, then push.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
