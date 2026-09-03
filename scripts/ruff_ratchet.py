"""Keep the selected Ruff debt stable until an intentional baseline update."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path, PurePosixPath
from typing import Any


EXPECTED_RUFF_VERSION = "ruff 0.15.21"
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASELINE = ROOT / "scripts" / "ruff_baseline.json"
RUFF_ARGS = [
    "check",
    ".",
    "--isolated",
    "--no-cache",
    "--select",
    "E4,E7,E9,F",
    "--target-version",
    "py311",
    "--output-format",
    "json",
]

Baseline = dict[str, dict[str, dict[str, int]]]
FINGERPRINT_RE = re.compile(r"[0-9a-f]{64}")


def _run(command: list[str], root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=root, text=True, capture_output=True, check=False)


def _relative_posix_path(filename: str, root: Path) -> str:
    candidate = Path(filename)
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        return candidate.resolve().relative_to(root.resolve()).as_posix()
    except ValueError as error:
        raise ValueError(f"Ruff reported a path outside the repository: {filename}") from error


def _stable_ast_dump(node: ast.AST) -> str:
    """Serialize an AST identically on Python 3.11 and newer runtimes."""
    try:
        return ast.dump(node, include_attributes=False, show_empty=True)
    except TypeError:
        # Python 3.11 and 3.12 always include empty fields. Python 3.13 added
        # show_empty and changed the default to false.
        return ast.dump(node, include_attributes=False)


def _semantic_source_identity(source_span: str) -> str:
    """Normalize parseable Ruff spans without erasing their Python semantics."""
    for mode in ("eval", "exec"):
        try:
            tree = ast.parse(source_span, mode=mode)
        except (SyntaxError, ValueError):
            continue
        return f"ast:{_stable_ast_dump(tree)}"
    return f"text:{source_span}"


def _definition_identity(
    node: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef,
) -> str:
    """Describe a definition header independently of whitespace and line numbers."""
    if isinstance(node, ast.ClassDef):
        kind = "class"
        header = [node.bases, node.keywords, node.decorator_list]
    else:
        kind = "async-function" if isinstance(node, ast.AsyncFunctionDef) else "function"
        header = [node.args, node.decorator_list, node.returns, node.type_comment]
    serialized = json.dumps(
        [
            _stable_ast_dump(value) if isinstance(value, ast.AST)
            else [_stable_ast_dump(item) for item in value]
            if isinstance(value, list)
            else value
            for value in header
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    discriminator = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    return f"{kind}:{node.name}:{discriminator}"


def _statements_contain_row(statements: list[ast.stmt], row: int) -> bool:
    return any(
        statement.lineno <= row <= end_lineno
        for statement in statements
        if isinstance((end_lineno := getattr(statement, "end_lineno", None)), int)
    )


def _node_contains_row(node: ast.AST | None, row: int) -> bool:
    if node is None:
        return False
    lineno = getattr(node, "lineno", None)
    end_lineno = getattr(node, "end_lineno", None)
    return (
        isinstance(lineno, int)
        and isinstance(end_lineno, int)
        and lineno <= row <= end_lineno
    )


def _ast_values_identity(*values: ast.AST | str | None) -> str:
    """Hash control-flow headers without depending on source coordinates."""
    serialized = json.dumps(
        [
            _stable_ast_dump(value) if isinstance(value, ast.AST) else value
            for value in values
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _optional_ast_type(name: str) -> type[ast.AST] | None:
    """Return an optional AST node type without raising on older Python."""
    candidate = getattr(ast, name, None)
    return candidate if isinstance(candidate, type) and issubclass(candidate, ast.AST) else None


def _control_flow_identity(node: ast.AST) -> str | None:
    """Describe a control-flow statement header independently of its location."""
    if isinstance(node, ast.If):
        return f"if:{_ast_values_identity(node.test)}"
    if isinstance(node, (ast.For, ast.AsyncFor)):
        kind = "async-for" if isinstance(node, ast.AsyncFor) else "for"
        return f"{kind}:{_ast_values_identity(node.target, node.iter)}"
    if isinstance(node, ast.While):
        return f"while:{_ast_values_identity(node.test)}"

    try_star_type = _optional_ast_type("TryStar")
    try_types = (ast.Try,) + ((try_star_type,) if try_star_type is not None else ())
    if isinstance(node, try_types):
        kind = "try-star" if try_star_type is not None and isinstance(node, try_star_type) else "try"
        return kind

    match_type = _optional_ast_type("Match")
    if match_type is not None and isinstance(node, match_type):
        return f"match:{_ast_values_identity(node.subject)}"
    return None


def _local_occurrence(identities: list[str], target_index: int) -> int:
    """Return a direct sibling ordinal among equal local branch identities."""
    target = identities[target_index]
    return sum(identity == target for identity in identities[:target_index])


def _try_kind(node: ast.AST) -> str:
    try_star_type = _optional_ast_type("TryStar")
    return "try-star" if try_star_type is not None and isinstance(node, try_star_type) else "try"


def _try_handler_tokens(node: ast.AST) -> list[tuple[ast.AST, str]]:
    kind = _try_kind(node)
    # ``except ... as name`` only binds a local alias.  It does not alter the
    # exception-control path, so alias renames must not churn findings in this
    # handler or in the try body.  The exception type and local duplicate
    # ordinal still distinguish materially different handler structure.
    identities = [_ast_values_identity(handler.type) for handler in node.handlers]
    return [
        (handler, f"{kind}:handler:{identity}:local:{_local_occurrence(identities, index)}")
        for index, (handler, identity) in enumerate(zip(node.handlers, identities))
    ]


def _try_body_token(node: ast.AST) -> str:
    """Describe a try body by its ordered local exception-control structure.

    Changing that structure deliberately changes body-finding identities: it
    materially changes which exception paths own the body. The ratchet is
    fail-closed for that case, while handler-finding tokens stay independent
    of unrelated body statements and handlers.
    """
    kind = _try_kind(node)
    handlers = [token for _handler, token in _try_handler_tokens(node)]
    return f"{kind}:body:{_ast_values_identity(*handlers)}"


def _match_case_tokens(node: ast.AST) -> list[tuple[ast.AST, str]]:
    subject = _ast_values_identity(node.subject)
    identities = [_ast_values_identity(case.pattern, case.guard) for case in node.cases]
    return [
        (case, f"match:{subject}:case:{identity}:local:{_local_occurrence(identities, index)}")
        for index, (case, identity) in enumerate(zip(node.cases, identities))
    ]


def _control_flow_branch_tokens(node: ast.AST) -> list[str]:
    """Return every local token a control-flow sibling can own."""
    identity = _control_flow_identity(node)
    if identity is None:
        return []
    if isinstance(node, (ast.If, ast.For, ast.AsyncFor, ast.While)):
        tokens = [f"{identity}:body", f"{identity}:header"]
        if node.orelse:
            tokens.append(f"{identity}:else")
        return tokens

    try_star_type = _optional_ast_type("TryStar")
    try_types = (ast.Try,) + ((try_star_type,) if try_star_type is not None else ())
    if isinstance(node, try_types):
        kind = _try_kind(node)
        tokens = [_try_body_token(node), *(token for _handler, token in _try_handler_tokens(node))]
        if node.orelse:
            tokens.append(f"{kind}:else")
        if node.finalbody:
            tokens.append(f"{kind}:finally")
        return tokens

    match_type = _optional_ast_type("Match")
    if match_type is not None and isinstance(node, match_type):
        return [f"match:{_ast_values_identity(node.subject)}:header", *(
            token for _case, token in _match_case_tokens(node)
        )]
    return []


def _control_flow_branch_token(node: ast.AST, row: int) -> str | None:
    """Return the local branch token that owns ``row``."""
    identity = _control_flow_identity(node)
    if identity is None:
        return None
    if isinstance(node, ast.If):
        if _statements_contain_row(node.body, row):
            return f"{identity}:body"
        if _statements_contain_row(node.orelse, row):
            return f"{identity}:else"
        return f"{identity}:header" if _node_contains_row(node.test, row) else None

    if isinstance(node, (ast.For, ast.AsyncFor)):
        if _statements_contain_row(node.body, row):
            return f"{identity}:body"
        if _statements_contain_row(node.orelse, row):
            return f"{identity}:else"
        return (
            f"{identity}:header"
            if _node_contains_row(node.target, row) or _node_contains_row(node.iter, row)
            else None
        )

    if isinstance(node, ast.While):
        if _statements_contain_row(node.body, row):
            return f"{identity}:body"
        if _statements_contain_row(node.orelse, row):
            return f"{identity}:else"
        return f"{identity}:header" if _node_contains_row(node.test, row) else None

    try_star_type = _optional_ast_type("TryStar")
    try_types = (ast.Try,) + ((try_star_type,) if try_star_type is not None else ())
    if isinstance(node, try_types):
        kind = _try_kind(node)
        if _statements_contain_row(node.body, row):
            return _try_body_token(node)
        for handler, token in _try_handler_tokens(node):
            if _node_contains_row(handler, row):
                return token
        if _statements_contain_row(node.orelse, row):
            return f"{kind}:else"
        if _statements_contain_row(node.finalbody, row):
            return f"{kind}:finally"
        return None

    match_type = _optional_ast_type("Match")
    if match_type is not None and isinstance(node, match_type):
        for case, token in _match_case_tokens(node):
            if (
                _statements_contain_row(case.body, row)
                or _node_contains_row(case.pattern, row)
                or _node_contains_row(case.guard, row)
            ):
                return token
        return f"match:{_ast_values_identity(node.subject)}:header" if _node_contains_row(node.subject, row) else None

    return None


def _branch_sibling_occurrence(tree: ast.AST, node: ast.AST, token: str) -> int | None:
    """Number equal branch tokens among direct control-flow siblings.

    Inserting or removing a sibling with an equal token necessarily changes the
    ordinal. This fail-closed churn is unavoidable without a persistent node
    ID, while siblings with other branch tokens leave the finding stable.
    """
    for parent in ast.walk(tree):
        for _field, value in ast.iter_fields(parent):
            if not isinstance(value, list) or not any(sibling is node for sibling in value):
                continue
            matching = [
                sibling
                for sibling in value
                if isinstance(sibling, ast.AST) and token in _control_flow_branch_tokens(sibling)
            ]
            return matching.index(node) if len(matching) > 1 else None
    return None


def _control_flow_branch_identity(tree: ast.AST, node: ast.AST, row: int) -> str | None:
    token = _control_flow_branch_token(node, row)
    if token is None:
        return None
    occurrence = _branch_sibling_occurrence(tree, node, token)
    suffix = "" if occurrence is None else f":sibling:{occurrence}"
    return f"{token}{suffix}"


def _scope_context(tree: ast.AST, row: int) -> list[str]:
    """Return stable definition and control-flow ownership for one row."""
    contexts: list[tuple[int, int, int, str]] = []
    for node in ast.walk(tree):
        end_lineno = getattr(node, "end_lineno", None)
        if not isinstance(end_lineno, int) or not node.lineno <= row <= end_lineno:
            continue
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            contexts.append(
                (node.lineno, node.col_offset, -end_lineno, _definition_identity(node))
            )
        else:
            branch_identity = _control_flow_branch_identity(tree, node, row)
            if branch_identity is None:
                continue
            contexts.append(
                (node.lineno, node.col_offset, -end_lineno, branch_identity)
            )
    contexts.sort(key=lambda entry: entry[:3])
    return ["module", *(entry[3] for entry in contexts)]


def _finding_fingerprint(
    diagnostic: dict[str, Any],
    *,
    filename: str,
    code: str,
    root: Path,
) -> str:
    """Identify one finding without depending on its absolute line number."""
    message = diagnostic.get("message")
    location = diagnostic.get("location")
    end_location = diagnostic.get("end_location")
    if (
        not isinstance(message, str)
        or not message
        or not isinstance(location, dict)
        or not isinstance(end_location, dict)
    ):
        raise RuntimeError("Ruff returned a diagnostic without stable identity fields")

    start_row = location.get("row")
    start_column = location.get("column")
    end_row = end_location.get("row")
    end_column = end_location.get("column")
    if (
        not isinstance(start_row, int)
        or isinstance(start_row, bool)
        or not isinstance(start_column, int)
        or isinstance(start_column, bool)
        or not isinstance(end_row, int)
        or isinstance(end_row, bool)
        or not isinstance(end_column, int)
        or isinstance(end_column, bool)
        or start_row < 1
        or start_column < 1
        or end_row < start_row
        or end_column < 1
    ):
        raise RuntimeError("Ruff returned a diagnostic with invalid source coordinates")

    source_path = root / PurePosixPath(filename)
    try:
        source_text = source_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise RuntimeError(f"Could not read Ruff source file {filename}") from error
    source_lines = source_text.splitlines()
    if start_row > len(source_lines) or end_row > len(source_lines):
        raise RuntimeError("Ruff returned a diagnostic outside its source file")
    start_line = source_lines[start_row - 1]
    end_line = source_lines[end_row - 1]
    if start_column > len(start_line) + 1 or end_column > len(end_line) + 1:
        raise RuntimeError("Ruff returned a diagnostic outside its source file")
    if start_row == end_row:
        if end_column <= start_column:
            raise RuntimeError("Ruff returned a diagnostic with an empty source span")
        source_span = start_line[start_column - 1:end_column - 1]
    else:
        span_lines = [start_line[start_column - 1:]]
        span_lines.extend(source_lines[start_row:end_row - 1])
        span_lines.append(end_line[:end_column - 1])
        source_span = "\n".join(span_lines)
    source_span = source_span.strip()
    if not source_span:
        raise RuntimeError("Ruff returned a diagnostic without source text")

    scope_context = ["module"]
    try:
        tree = ast.parse(source_text, filename=filename)
    except (SyntaxError, ValueError):
        # Syntax diagnostics cannot always be parsed into scopes. Keeping their
        # module context still lets the ratchet report the new E9 finding.
        tree = None
    if tree is not None:
        scope_context = _scope_context(tree, start_row)

    payload = json.dumps(
        [code, message, _semantic_source_identity(source_span), scope_context],
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def ruff_findings(root: Path) -> Baseline:
    version = _run([sys.executable, "-m", "ruff", "--version"], root)
    if version.returncode != 0 or version.stdout.strip() != EXPECTED_RUFF_VERSION:
        actual = version.stdout.strip() or version.stderr.strip() or "not available"
        raise RuntimeError(f"Expected {EXPECTED_RUFF_VERSION}; found {actual}")

    result = _run([sys.executable, "-m", "ruff", *RUFF_ARGS], root)
    if result.returncode not in {0, 1}:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise RuntimeError(f"Ruff did not complete successfully: {detail}")
    try:
        diagnostics: list[dict[str, Any]] = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("Ruff did not produce JSON diagnostics") from error

    grouped: defaultdict[str, defaultdict[str, defaultdict[str, int]]] = defaultdict(
        lambda: defaultdict(lambda: defaultdict(int))
    )
    for diagnostic in diagnostics:
        filename = diagnostic.get("filename")
        code = diagnostic.get("code")
        if not isinstance(filename, str) or not isinstance(code, str):
            raise RuntimeError("Ruff returned a diagnostic without filename or rule code")
        relative_filename = _relative_posix_path(filename, root)
        fingerprint = _finding_fingerprint(
            diagnostic,
            filename=relative_filename,
            code=code,
            root=root,
        )
        grouped[relative_filename][code][fingerprint] += 1
    return {
        filename: {
            code: dict(sorted(identities.items()))
            for code, identities in sorted(rules.items())
        }
        for filename, rules in sorted(grouped.items())
    }


def read_baseline(path: Path) -> Baseline:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read Ruff baseline {path}: {error}") from error
    if not isinstance(parsed, dict):
        raise RuntimeError("Ruff baseline must be a JSON object")
    baseline: Baseline = {}
    for filename, rules in parsed.items():
        posix_path = PurePosixPath(filename) if isinstance(filename, str) else None
        if (
            not isinstance(filename, str)
            or "\\" in filename
            or posix_path is None
            or posix_path.is_absolute()
            or ".." in posix_path.parts
            or posix_path.as_posix() != filename
        ):
            raise RuntimeError("Ruff baseline filenames must be POSIX relative paths")
        if not isinstance(rules, dict):
            raise RuntimeError(f"Ruff baseline rules for {filename} must be an object")
        normalized: dict[str, dict[str, int]] = {}
        for code, identities in rules.items():
            if not isinstance(code, str) or not isinstance(identities, dict):
                raise RuntimeError(f"Invalid Ruff baseline entry for {filename}")
            normalized_identities: dict[str, int] = {}
            for fingerprint, count in identities.items():
                if (
                    not isinstance(fingerprint, str)
                    or FINGERPRINT_RE.fullmatch(fingerprint) is None
                    or not isinstance(count, int)
                    or isinstance(count, bool)
                    or count < 1
                ):
                    raise RuntimeError(f"Invalid Ruff baseline entry for {filename}")
                normalized_identities[fingerprint] = count
            normalized[code] = normalized_identities
        baseline[filename] = normalized
    return baseline


def differences(expected: Baseline, actual: Baseline) -> list[str]:
    messages: list[str] = []
    for filename in sorted(set(expected) | set(actual)):
        expected_rules = expected.get(filename, {})
        actual_rules = actual.get(filename, {})
        for code in sorted(set(expected_rules) | set(actual_rules)):
            expected_identities = expected_rules.get(code, {})
            actual_identities = actual_rules.get(code, {})
            for fingerprint in sorted(set(expected_identities) | set(actual_identities)):
                before = expected_identities.get(fingerprint, 0)
                after = actual_identities.get(fingerprint, 0)
                if before == after:
                    continue
                direction = "increased" if after > before else "decreased"
                messages.append(
                    f"{filename} {code} {fingerprint[:12]}: "
                    f"{direction} from {before} to {after}"
                )
    return messages


def write_baseline(path: Path, baseline: Baseline) -> None:
    stable = {
        filename: {
            code: dict(sorted(baseline[filename][code].items()))
            for code in sorted(baseline[filename])
        }
        for filename in sorted(baseline)
    }
    path.write_text(json.dumps(stable, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def check(*, baseline_path: Path, update: bool, root: Path = ROOT) -> int:
    actual = ruff_findings(root)
    if update:
        write_baseline(baseline_path, actual)
        print("Updated Ruff baseline.")
        return 0
    expected = read_baseline(baseline_path)
    changes = differences(expected, actual)
    if not changes:
        print("Ruff ratchet matches baseline.")
        return 0
    print("Ruff findings differ from the baseline. Run with --update after reviewing the change:")
    print("\n".join(changes))
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--update", action="store_true", help="write the reviewed current findings as baseline")
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        return check(baseline_path=args.baseline, update=args.update)
    except RuntimeError as error:
        print(f"ruff ratchet: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
