import json
from workers import WorkerEntrypoint, Response
from engine import execute, InputError


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        if request.method != 'POST':
            return Response('Method not allowed', status=405)
        try:
            raw = await request.text()
            # The public Worker enforces a streaming envelope limit as well.
            if len(raw.encode('utf-8')) > 1024 * 1024:
                return Response('Request too large', status=413)
            result = execute(json.loads(raw))
            return Response(json.dumps(result, ensure_ascii=False), headers={'Content-Type': 'application/json', 'Cache-Control': 'no-store'})
        except (InputError, json.JSONDecodeError):
            return Response('{"error":"invalid_input"}', status=400, headers={'Content-Type':'application/json'})
        except Exception:
            # Never return exception messages or tracebacks containing manuscript text.
            return Response('{"error":"inspection_failed"}', status=500, headers={'Content-Type':'application/json'})
