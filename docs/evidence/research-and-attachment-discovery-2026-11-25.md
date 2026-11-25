# Research and delivery in one turn

The DAY-1 journey needs one request to read a fresh source, save a verified artifact and deliver its bytes. On `504398a3` the pinned free model fetched the official GitHub CLI release, and the workspace file had the verified tag, date and release link. The final message said the file was in the project. The Bot API received no attachment. The opening menu contained `send_file`, but subsequent menus dropped it after the model discovered `http_get`.

Both schemas were authorized. Tool discovery stages a new selection for the next model call. The current projection replaces earlier selections, even after a miss. Authorization and execution still use the existing kernel. This is a STANDARD experiment on the presentation of authorized schemas.

| Candidate | Expected benefit | Falsifier or cost |
| --- | --- | --- |
| Better prompt on each search | Could remind the model to use a second search for delivery | Still requires the model to repair a disappearing menu. The observed model ended without asking twice. |
| Make every common completion tool core | Keeps attachments visible and preserves incremental search | Adds schema weight for every turn, and the next multi-step task can lose a different selected tool. |
| Keep discovered or preloaded schemas through the current turn | Allows multiple effects to stay reachable without an extra search. Loaded schemas stay in the context of the turn. | Extra schema tokens for turns reaching many distinct tools. Check the opening menu, the accumulated set, and unrelated tools remaining hidden. |

Try a cumulative projection drawn from the same filtered catalogue. It does not alter approvals, permissions or the execution registry. Prove that a later search and a miss preserve earlier selected schemas, including the artifact tool, and repeat the original real-inference task. Verify bytes at the receiving API, separate from file existence and the final reply. This does not exercise a configured web search backend.

Anthropic documents expanding discovered tool references into full definitions inline in the conversation. OpenAI documents deferred tools produced by tool search. These are integration interfaces, without evidence for the private behavior of either end-user product. [Anthropic tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool), [OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search).

## Results

| Evidence | Replacing selection `504398a3` | Cumulative selection `c6fc6750` |
| --- | --- | --- |
| Real public source and workspace file | Correct tag, date and link | Correct tag, date and link |
| Loopback Telegram document | Zero attachments | One attachment in the original chat, identical SHA-256 to the workspace file |
| Unprompted tool repair | The model ended after reporting that the file existed | The model called `send_file` after reading and writing |
| Owner actions | One request, zero approvals | One request, zero approvals |
| Free-model observations | Five HTTP 200 requests, 105 seconds | Five HTTP 200 requests and three recovered 503s, 130 seconds |

The numbers describe two runs, with no latency comparison across upstream conditions. Both used the pinned free model with embeddings off and zero reported cost. The source was [the official live release endpoint](https://api.github.com/repos/cli/cli/releases/latest) and artifact facts were checked by an independent request after the turn. The prototype used loopback Telegram, with no owner data or configured web search.

An independent compiled fixture discovers an attachment tool and then the runtime inspector. It checks both schemas in the next model request, workspace bytes, the attachment and the final reply. Restoring the old selection code in a disposable compiled binary made the fixture fail at the second menu check. The focused projection suite passed seven cases, including a miss, preservation of earlier selections and exclusion of unauthorized tools.
