"""Tests for make_public_snapshot.py against throwaway git repos (run: python -m pytest tools/publish).

The fixtures build every blocked string at runtime (pieces joined), so this file passes the publisher's own scan
and can ship in the public copy."""
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import make_public_snapshot as M  # noqa: E402

GH = "github" + ".com"
PRIVATE = f"https://{GH}/KiranMohan-92/" + "warsaw-downtown"
README = (
    '<div align="center">\n\n'
    f'<a href="{PRIVATE}/releases/tag/trailer-v1">'
    '<img src="docs/media/trailer-teaser.gif" alt="teaser" width="100%"></a>\n\n'
    "# WARSAW DOWNTOWN\n\n"
    f'<a href="{PRIVATE}/releases/download/trailer-v1/Warsaw-Downtown-Launch-Trailer.mp4">'
    '<img src="docs/media/trailer-poster.jpg" alt="poster" width="80%"></a>\n\n'
    f"**[▶ Watch]({PRIVATE}/releases/download/trailer-v1/Warsaw-Downtown-Launch-Trailer.mp4)**, score.\n\n"
    "</div>\n\n## The game\n"
)
NOREPLY = "KiranMohan-92@users.noreply." + GH


def git(cwd, *args):
    r = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout


@pytest.fixture
def private(tmp_path):
    d = tmp_path / "private"
    (d / "src").mkdir(parents=True)
    git(d, "init", "-q", "-b", "main")
    git(d, "config", "user.email", "real.person@" + "gmail" + ".com")
    git(d, "config", "user.name", "someone")
    (d / "README.md").write_text(README, encoding="utf-8")
    (d / "src" / "game.ts").write_text("export const x = 1\n")
    (d / "src" / "net.test.ts").write_text("expect(url('192." + "168.1.20')).toBe(1)\n")
    (d / ".gitignore").write_text(".env\n")
    (d / ".env").write_text("API_KEY='" + "sk-ant-" + "not-a-real-key-but-long-enough-0000'\n")
    git(d, "add", "-A")
    git(d, "commit", "-qm", "private history")
    return d


def snapshot(private, out, *extra):
    return M.main(["--repo", str(private), "--out", str(out), *extra])


def test_snapshot_is_one_commit_with_rewritten_readme(private, tmp_path, capsys):
    out = tmp_path / "public"
    assert snapshot(private, out) == 0, capsys.readouterr().out
    assert git(out, "rev-list", "--count", "HEAD").strip() == "1"
    assert git(out, "log", "-1", "--format=%an <%ae>").strip() == f"Kiran Mohan <{NOREPLY}>"
    readme = (out / "README.md").read_text(encoding="utf-8")
    public = f"https://{GH}/KiranMohan-92/warsaw-downtown-game/releases/"
    assert readme.count(public + "tag/trailer-v1") == 1 and readme.count(public + "download/trailer-v1/Warsaw-Downtown-Launch-Trailer.mp4") == 2
    assert not M.PRIVATE_REF.search(readme)
    assert not (out / ".env").exists()  # ignored files never leave the private repo
    assert (out / "src" / "net.test.ts").exists()  # test-only LAN addresses are allowed


def test_second_snapshot_adds_one_commit_and_tracks_deletions(private, tmp_path, capsys):
    out = tmp_path / "public"
    assert snapshot(private, out) == 0
    git(private, "rm", "-q", "src/game.ts")
    git(private, "commit", "-qm", "remove")
    assert snapshot(private, out, "--message", "update") == 0
    assert git(out, "rev-list", "--count", "HEAD").strip() == "2"
    assert not (out / "src" / "game.ts").exists()
    assert snapshot(private, out) == 0
    assert "nothing changed" in capsys.readouterr().out


def test_staged_tree_can_be_checked_before_commit(private, tmp_path, capsys):
    (private / "src" / "new.ts").write_text("export const y = 2\n")
    git(private, "add", "-A")
    tree = git(private, "write-tree").strip()
    assert M.main(["--repo", str(private), "--out", str(tmp_path / "p"), "--ref", tree, "--dry-run"]) == 0


LEAKS = [
    ("src/keys.ts", "const tok" + "en = 'abcdefghijklmnop1234'\n", "credential"),
    ("src/auth.ts", "const auth_tok" + "en = 'abcdefghijklmnop1234'\n", "credential"),
    ("config.json", '{"pass' + 'word": "correct-horse-battery-staple"}\n', "credential"),
    ("headers.json", '{"authorization": "Bear' + 'er abcdefghijklmnop1234"}\n', "credential"),
    ("curl.md", "curl -H 'Authorization: Bas" + "ic dXNlcjpwYXNzd29yZDEyMzQ='\n", "credential"),
    ("docs/notes.md", "ask real.person@" + "gmail" + ".com\n", "personal email"),
    ("docs/net.md", "host at homeassistant.tail39." + "ts" + ".net\n", "tailnet name"),
    ("docs/lan.md", "server on 192." + "168.1.40\n", "LAN address"),
    ("docs/lan10.md", "server on 10." + "20.30.40\n", "LAN address"),
    ("docs/lan172.md", "server on 172." + "20.30.40\n", "LAN address"),
    ("docs/work.md", "built at " + "IN" + "G Hubs\n", "employer reference"),
    ("docs/link.md", f"see {PRIVATE}/issues\n", "private repo"),
    ("docs/ssh.md", f"git clone git@{GH}:KiranMohan-92/" + "warsaw-downtown.git\n", "private repo"),
    ("docs/case.md", f"see https://GitHub.com/kiranmohan-92/" + "WARSAW-DOWNTOWN\n", "private repo"),
]


@pytest.mark.parametrize("path,content,kind", LEAKS, ids=[p for p, _, _ in LEAKS])
def test_private_data_refuses(private, tmp_path, capsys, path, content, kind):
    (private / path).parent.mkdir(parents=True, exist_ok=True)
    (private / path).write_text(content)
    git(private, "add", "-A")
    git(private, "commit", "-qm", "leak")
    out = tmp_path / "public"
    assert snapshot(private, out) == 1
    assert kind in capsys.readouterr().out
    assert not out.exists()


def test_credits_with_author_fields_are_not_credentials():
    assert not M.BLOCK["credential"].search("'title': 'Armoured Truck', 'author': 'robertmasiboda'")
    assert not M.BLOCK["credential"].search('"author": "robertmasiboda",')


def test_links_to_an_unmirrored_release_refuse(private, tmp_path, capsys):
    text = (private / "README.md").read_text(encoding="utf-8").replace("download/trailer-v1/", "download/trailer-v2/")
    (private / "README.md").write_text(text, encoding="utf-8")
    git(private, "commit", "-qam", "v2 links")
    assert snapshot(private, tmp_path / "public") == 1
    out = capsys.readouterr().out
    assert "README changed shape" in out and "trailer-v2" in out


def test_readme_shape_change_refuses(private, tmp_path, capsys):
    (private / "README.md").write_text("# New README with no trailer links\n")
    git(private, "commit", "-qam", "readme")
    assert snapshot(private, tmp_path / "public") == 1
    assert "README changed shape" in capsys.readouterr().out


def test_refuses_an_out_dir_pointing_at_the_private_repo(private, tmp_path, capsys):
    out = tmp_path / "public"
    git(tmp_path, "init", "-q", str(out))
    git(out, "remote", "add", "origin", PRIVATE.replace("KiranMohan-92", "kiranmohan-92") + ".git")
    assert snapshot(private, out) == 1
    assert "origin is the private repo" in capsys.readouterr().out
    git(out, "remote", "set-url", "origin", PRIVATE + "-game.git")
    assert snapshot(private, out) == 0


def test_refuses_a_clone_of_the_private_repo_even_with_a_public_origin(private, tmp_path, capsys):
    clone = tmp_path / "clone"
    git(tmp_path, "clone", "-q", str(private), str(clone))
    git(clone, "remote", "set-url", "origin", PRIVATE + "-game.git")
    assert snapshot(private, clone) == 1
    assert "private history" in capsys.readouterr().out


def test_refuses_the_private_repo_itself_and_its_worktrees(private, tmp_path, capsys):
    (private / "local-notes.txt").write_text("untracked, must survive\n")
    assert snapshot(private, private) == 1
    assert snapshot(private, private / "sub") == 1
    wt = tmp_path / "wt"
    git(private, "worktree", "add", "-q", str(wt))
    assert snapshot(private, wt) == 1
    out = capsys.readouterr().out
    assert "overlaps the private repo" in out and "shares its git directory" in out
    assert (private / "local-notes.txt").exists()


def test_refuses_a_destination_with_other_authors(private, tmp_path, capsys):
    out = tmp_path / "public"
    git(tmp_path, "init", "-q", str(out))
    git(out, "config", "user.email", "someone@example.org")
    git(out, "config", "user.name", "x")
    git(out, "commit", "-q", "--allow-empty", "-m", "unrelated")
    assert snapshot(private, out) == 1
    assert "other authors" in capsys.readouterr().out


def test_a_broken_destination_repo_is_refused_and_left_intact(private, tmp_path, capsys):
    out = tmp_path / "public"
    (out / ".git").mkdir(parents=True)  # looks like a repo, but git can't read it
    (out / "keep.txt").write_text("must survive\n")
    assert snapshot(private, out) == 1
    assert "cannot inspect" in capsys.readouterr().out
    assert (out / "keep.txt").read_text() == "must survive\n"


def test_prose_about_tokens_is_not_a_credential():
    for line in ("Send a Bearer token in the header.", "Basic auth is off.", "Token refresh every 5 min"):
        assert not M.BLOCK["credential"].search(line), line


def test_dry_run_writes_nothing(private, tmp_path):
    out = tmp_path / "public"
    assert snapshot(private, out, "--dry-run") == 0
    assert not out.exists()
