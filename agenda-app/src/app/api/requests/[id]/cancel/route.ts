import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getApiUser } from "@/lib/auth/session";
import { forbidden, isSameOrigin, unauthorized } from "@/lib/http/api";
import { createRequestDeps } from "@/lib/requests/deps";
import { cancelRequest } from "@/lib/requests/service";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getApiUser();
  if (!user) return unauthorized();
  if (!isSameOrigin(request)) return forbidden();

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ status: "error", message: "Richiesta non trovata." }, { status: 404 });
  }

  const result = await cancelRequest(await createRequestDeps(), user, id);
  return NextResponse.json(result, { status: result.status === "cancelled" ? 200 : 422 });
}
