"""Nexus scoped one-shot adapter; original md_cg dispatch remains authoritative."""
import json
import os
import sys

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def main():
    payload = json.load(sys.stdin)
    from md_cg.security import Principal
    from md_cg.mdcos import MdCGSecure
    from md_cg.mcp_server import call_tool
    trusted = payload["trusted"]
    principal = Principal(
        tenant="nexus", actor=trusted["actor"], clearance="private",
        can_write=trusted["writable"], can_admin=trusted["admin"],
        session=trusted["session"], harness="dsh-nexus",
        layers_allow=tuple(trusted.get("layers", ("contextual", "knowledge", "structural", "goals"))),
    )
    cg = MdCGSecure(os.environ["MDCG_ROOT"], principal=principal)
    args = dict(payload.get("args", {}))
    args["op"] = payload["op"]
    action = payload.get("action")
    if action:
        args["action"] = action
    try:
        result = call_tool(cg, "cg", args)
        cg.flush()
        print(json.dumps({"ok": True, "data": result}, ensure_ascii=False, default=str))
    finally:
        close = getattr(cg, "close", None)
        if close:
            close()

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
