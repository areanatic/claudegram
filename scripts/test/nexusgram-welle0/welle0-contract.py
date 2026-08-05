#!/usr/bin/env python3
"""Pure local parsers for the Welle-0 evidence contract.

This module deliberately knows nothing about Telegram, Pyrogram, or live bot
state.  Keeping the parser here makes the contract self-testable with fixture
strings and prevents a formatting change from silently weakening the gate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any


TOOL_NAME_RE = re.compile(r"\bmcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+\b")
CONNECTED_SERVERS_RE = re.compile(
    r"(?:verbundene\s+MCP-Server|connected\s+MCP\s+servers?)\s*:\s*([^\n\r]+)",
    re.IGNORECASE,
)
ERROR_CONTEXT_RE = re.compile(
    r"\b(?:warn(?:ung|ing)?|missing|fehl(?:t|er)|error|failed|degraded|"
    r"unavailable|nicht\s+verbunden)\b",
    re.IGNORECASE,
)
HASH_RE = re.compile(
    r"(?:\btools_sha256\b|\bMCP[- ](?:Tool(?:namen)?|tools)[^\n\r]{0,80}?"
    r"\bSHA-?256\b)[^\n\r]{0,80}?([0-9a-f]{64})",
    re.IGNORECASE,
)


def canonical_tool_names(tools: Iterable[str]) -> list[str]:
    """Return the unique tool names in the contract's canonical sort order."""
    return sorted(set(tools))


def tools_sha256(tools: Iterable[str]) -> str:
    """Hash sorted tool names exactly as ``printf '%s\\n' ... | shasum`` would."""
    canonical = canonical_tool_names(tools)
    payload = "\n".join(canonical) + "\n"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def load_expected_contract(path: str | Path, *, require_hash: bool = True) -> dict[str, Any]:
    """Load and fail closed on a malformed or non-canonical contract."""
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read expected MCP contract: {error}") from error

    servers = raw.get("servers")
    tools = raw.get("tools")
    if not isinstance(servers, list) or not all(isinstance(server, str) for server in servers):
        raise ValueError("contract servers must be a string list")
    if not isinstance(tools, list) or not all(isinstance(tool, str) for tool in tools):
        raise ValueError("contract tools must be a string list")
    if servers != sorted(set(servers)):
        raise ValueError("contract servers must be unique and sorted")
    if tools != canonical_tool_names(tools):
        raise ValueError("contract tools must be unique and sorted")

    expected_hash = raw.get("tools_sha256")
    if require_hash and not isinstance(expected_hash, str):
        raise ValueError("contract tools_sha256 is required")
    if isinstance(expected_hash, str) and expected_hash != tools_sha256(tools):
        raise ValueError("contract tools_sha256 does not match its sorted tools")
    return raw


def connected_servers_from_reply(reply: str) -> set[str]:
    """Read only affirmative connection lines, never a missing/error warning."""
    connected: set[str] = set()
    for line in reply.splitlines():
        if ERROR_CONTEXT_RE.search(line):
            continue
        match = CONNECTED_SERVERS_RE.search(line)
        if not match:
            continue
        connected.update(re.findall(r"[A-Za-z0-9_-]+", match.group(1)))
    return connected


def hashes_from_reply(reply: str) -> set[str]:
    return {match.group(1).lower() for match in HASH_RE.finditer(reply)}


def validate_inventory(contract: dict[str, Any], reply: str) -> list[str]:
    """Return every contract violation; an empty list is the only PASS state."""
    expected_servers = contract["servers"]
    expected_tools = contract["tools"]
    expected_hash = contract["tools_sha256"]

    connected = connected_servers_from_reply(reply)
    errors = [
        f"required server lacks affirmative connected context: {server}"
        for server in expected_servers
        if server not in connected
    ]

    # There is intentionally no count-based path.  The raw list branch requires
    # the exact canonical sequence, so replacement at the same cardinality fails.
    observed_tools = TOOL_NAME_RE.findall(reply)
    exact_tool_set = observed_tools == expected_tools
    hash_matches = expected_hash.lower() in hashes_from_reply(reply)
    if not (exact_tool_set or hash_matches):
        if observed_tools:
            errors.append("observed MCP tool names are not the exact sorted contract set")
        else:
            errors.append("no exact sorted MCP tool set or matching tools_sha256 observed")
    return errors


def cmd_json_field(args: argparse.Namespace) -> int:
    value = args.fallback
    for line in sys.stdin.read().splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and args.field in parsed:
            value = parsed[args.field]
    print(value)
    return 0


def cmd_check_inventory(args: argparse.Namespace) -> int:
    try:
        contract = load_expected_contract(args.expected)
    except ValueError as error:
        print(f"invalid MCP contract: {error}", file=sys.stderr)
        return 2

    errors = validate_inventory(contract, sys.stdin.read())
    if errors:
        print("; ".join(errors), file=sys.stderr)
        return 1
    return 0


def cmd_hash(args: argparse.Namespace) -> int:
    try:
        contract = load_expected_contract(args.expected, require_hash=False)
    except ValueError as error:
        print(f"invalid MCP contract: {error}", file=sys.stderr)
        return 2
    print(f'"tools_sha256": "{tools_sha256(contract["tools"])}"')
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)

    json_field = subcommands.add_parser("json-field")
    json_field.add_argument("field")
    json_field.add_argument("fallback")
    json_field.set_defaults(func=cmd_json_field)

    check_inventory = subcommands.add_parser("check-inventory")
    check_inventory.add_argument("--expected", required=True)
    check_inventory.set_defaults(func=cmd_check_inventory)

    hash_command = subcommands.add_parser("hash")
    hash_command.add_argument("--expected", required=True)
    hash_command.set_defaults(func=cmd_hash)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
