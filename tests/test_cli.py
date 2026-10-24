import json
from flock_of_pain.cli import main
from flock_of_pain.io import company_to_dict
from flock_of_pain.examples import reynolds

def test_export_example_and_company_flag(tmp_path, capsys):
    p = tmp_path / "c.json"
    assert main(["export-example", str(p)]) == 0
    assert json.loads(p.read_text()) == company_to_dict(reynolds.build())
    assert main(["demo", "--company", str(p), "--days", "1", "--reps", "1"]) == 0
    assert "baseline" in capsys.readouterr().out
