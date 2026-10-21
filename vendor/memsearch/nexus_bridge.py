"""Nexus entry point: scoped state and original Memsearch CLI/candidate parsing."""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

def main():
    state = Path(os.environ["NEXUS_MEMSEARCH_STATE"]).resolve()
    state.mkdir(parents=True, exist_ok=True)
    os.environ["MEMSEARCH_DIR"] = str(state)
    import memsearch.config as config
    # Do not read an unrelated user's global provider configuration.
    config.GLOBAL_CONFIG_PATH = state / "config.toml"
    config.PROJECT_CONFIG_PATH = state / "project-indexing.toml"
    if len(sys.argv) > 1 and sys.argv[1] == "nexus-apply-candidates":
        from memsearch import skills
        payload = json.load(sys.stdin)
        candidates = skills._parse_distill_response(payload["modelOutput"])
        root = skills.skills_root(state)
        skills._ensure_git(root)
        results = []
        for item in candidates[:int(payload.get("maxCandidates", 10))]:
            results.append({"name": item["name"], "state": skills._write_candidate(root, item)})
        if any(item["state"] != "unchanged" for item in results):
            skills._git_commit(root, "Nexus explicit distill: review candidates")
        print(json.dumps({"items": results, "enabled": False, "reviewRequired": True}, ensure_ascii=False))
    else:
        from memsearch.cli import cli
        cli()

if __name__ == "__main__":
    main()
