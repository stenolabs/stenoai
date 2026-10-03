# steno

A skill that makes an AI agent aware of your local
[Steno](https://github.com/stenolabs/stenoai) meeting notes, so you can run
`/steno` (or just mention your meetings) and have the agent pull the right notes
in and act on them — answer a question, recap your week, extract action items, or
use the meetings as source material to draft a spec, PRD, or follow-up.

Steno records and transcribes entirely on-device; this skill only **reads** the
files it already writes. It never modifies, moves, or deletes anything.

## What you can ask it

- **Answer across meetings** — *"/steno what did we decide about pricing?"*
- **Pull one meeting in** — *"/steno summarize the Acme call"* (with transcript if needed)
- **Recap a range** — *"/steno recap this week's meetings"*
- **Extract action items / decisions** — *"/steno my open action items from this week"*
- **Ground a document in real meetings** — *"/steno write a spec from the Acme discovery calls"*
- **Set up a cloud model** — *"/steno setup"* / *"help me configure Bedrock in Steno"* — a guided
  walkthrough for OpenAI, Anthropic, AWS Bedrock, or a custom endpoint (see
  `references/provider-setup.md`).

Under the hood, the notes functions use one read-only CLI (`scripts/steno.py`:
`locate` / `list` / `read` / `search` / `folders`) to find and pull the notes,
then the agent does the reasoning. Setup is guidance only — it never changes your
config or touches AWS.

## Requirements

- **Python 3.8+** — standard library only. **No dependencies, no `pip install`,
  no venv.** (If you have [`uv`](https://docs.astral.sh/uv/), `uv run` works too
  and will fetch a Python for you if you don't have one — see below.)
- Steno installed and used on the same machine (so there are notes to read).

## Install

See [Use Steno with your agent](https://docs.stenoai.co/features/agents) for the
setup guide, examples, and troubleshooting.

There's no build or package step — the skill is a **self-contained folder**
(`SKILL.md` + `scripts/steno.py`). "Installing" just means putting it where your
agent looks for skills:

Open **Agents** in Steno's sidebar, copy the install prompt for your agent,
and paste it into that agent running on the same computer as your notes.
The agent downloads the skill; Steno does not install files into other apps.

### Claude Code

Copy the install prompt from [the Claude Code setup guide](https://docs.stenoai.co/features/agents#claude-code).

You can also copy the complete `skills/steno` folder from a checkout into
`~/.claude/skills/steno`, or `.claude/skills/steno` for one project.
Run `/steno <request>`. See [Claude Code skills](https://code.claude.com/docs/en/skills).

### Codex

Copy the install prompt from [the Codex setup guide](https://docs.stenoai.co/features/agents#codex).

For manual installation, copy the complete folder into `~/.agents/skills/steno`
(personal) or `.agents/skills/steno` (one project). Invoke `$steno` in Codex CLI
or the IDE extension, or select the skill in the app's skill picker. If the skill
does not appear, restart Codex. See [OpenAI's skill documentation](https://developers.openai.com/codex/skills).

### Other agents

Point your agent at the complete skill folder, or run `scripts/steno.py` directly.
The skill needs local file access to your Steno notes; a hosted agent without
access to this computer cannot read them.

## Running the CLI (two equivalent ways)

```bash
# Plain Python — works anywhere Python 3.8+ is on PATH:
python3 scripts/steno.py locate

# Or with uv (bootstraps a Python if you don't have one; reads the PEP 723
# metadata in the script — still zero third-party deps):
uv run scripts/steno.py locate
```

## Use the CLI directly

```bash
cd steno
python3 scripts/steno.py locate                  # confirm it found your notes
python3 scripts/steno.py list --since 2026-07-01
python3 scripts/steno.py read "acme" -t          # summary + transcript
python3 scripts/steno.py search "action items" -t --json
python3 scripts/steno.py folders
```

If `locate` reports 0 meetings, point it at the store:

```bash
python3 scripts/steno.py --notes-dir "/path/to/your/steno" list
# or the same override Steno uses:
STENOAI_USER_DATA_DIR="/path/to/your/steno" python3 scripts/steno.py list
```

Every command accepts `--json` for machine-readable output.

## Privacy

Your meetings never leave your device through this skill — it only reads local
files. Whether an agent *using* this skill sends any of that content elsewhere is
up to that agent and how you run it; treat summaries and transcripts as
confidential.
