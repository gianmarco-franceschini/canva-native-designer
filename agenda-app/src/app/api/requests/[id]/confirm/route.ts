import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getApiUser } from "@/lib/auth/session";
import { forbidden, isSameOrigin, jsonError, unauthorized } from "@/lib/http/api";
import { createRequestDeps } from "@/lib/requests/deps";
import { confirmRequest } from "@/lib/requests/service";

const bodySchema = z.object({ allowConflict: z.boolean() });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getApiUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden();

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ status: "error", message: "Richiesta non trovata." }, { status: 404 });
  }
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return jsonError(400, "Richiesta non valida");

  const result = await confirmRequest(await createRequestDeps(), user, id, body.data.allowConflict);
  switch (result.status) {
    case "confirmed":
      return NextResponse.json(result);
    case "conflict":
      return NextResponse.json(
        {
          status: "conflict",
          conflicts: result.conflicts.map((c) => ({
            email: c.email,
            start: c.start.toISOString(),
            end: c.end.toISOString(),
          })),
        },
        { status: 409 },
      );
    case "error":
      return NextResponse.json(result, { status: 422 });
  }
}
