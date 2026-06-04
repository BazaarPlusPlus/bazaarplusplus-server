export function buildRunBundleMultipartUpload(opts: {
  metadata: Record<string, unknown>;
  artifactBytes?: Uint8Array;
}): Request {
  const form = new FormData();
  form.set("metadata", JSON.stringify(opts.metadata));
  form.set(
    "artifact",
    new File(
      [opts.artifactBytes ?? new Uint8Array([1, 2, 3, 4])],
      "run-bundle.mpack.gz",
      { type: "application/x-bpp-runbundle+msgpack+gzip" },
    ),
  );
  return new Request("https://example.com/run-bundles", {
    method: "POST",
    body: form,
  });
}

export function runBundleMetadata(opts?: {
  runId?: string;
  uploader?: string;
  battles?: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  const runId = opts?.runId ?? "run-001";
  const uploader = opts?.uploader ?? "player-001";
  return {
    schema_version: 5,
    player_account_id: uploader,
    submitted_at_utc: "2026-05-26T00:00:00.000Z",
    artifact_codec: "application/x-bpp-runbundle+msgpack+gzip",
    run_projection: {
      run_id: runId,
      status: "completed",
      hero_id: "hero-a",
      hero_name: "HeroA",
      started_at_utc: "2026-05-26T08:30:00.000+08:00",
      ended_at_utc: "2026-05-26T09:00:00.000+08:00",
      final_day: 10,
      final_wins: 9,
      final_losses: 3,
    },
    battle_projections: opts?.battles ?? [],
  };
}
