# Built-in template quality cases

`template-quality.json` contains eight synthetic conversations: one English and
one German case for each editable built-in. No recordings or personal meeting
content are used. `expectations` are a human review rubric, not substring tests.

Compare current and proposed prompts using the production
`OllamaSummarizer._create_template_report_prompt` helper with each case's resolved
`language`, then the same local model and decoding options for both versions.
Use the chat API with one user message and `think=false`, matching template
reports. Keep the model, options and before/after outputs with the evaluation.
A mocked completion or a matching heading is not a quality assertion.

Review factual support, retained qualifications and disagreements, correct
speakers and action owners, requested versus accepted actions, output language,
and repetition. Read the transcript as well as the listed expectations. A shorter
report alone is not a pass. An omitted material disagreement, invented commitment,
or reassigned action should block release of the prompt change.

## Initial local comparison, 2026-09-05

Gemma `gemma4:e2b-it-qat`, temperature 0, seed 42, context 8192, output limit 1100.
All 16 before/after calls completed without truncation. Reports are generally
more compact, and the final demo cases distinguish demonstrated CSV export from
promised SSO and unavailable offline access. The comparison does not establish
release quality:

- Both demo outputs assign the security-document request to the vendor despite
  the transcript leaving its owner unconfirmed.
- The German 1:1 omits Nora's disagreement, which the baseline retained.
- The English standup omits Sam's accepted pairing action, which the baseline
  retained; the German standup repeats the unassigned migration topic.
- The English sales report omits the explicit absence of a purchase commitment.

These are open quality cases, not passing model assertions. The prompt changes
remain a draft and should not be included in a release solely on green unit or
CRUD tests. Existing user overrides and the locked Standard template are unchanged.
