import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { api } from "../api";
import { Button } from "../components";
import { AuthCard, Field } from "./Layout";

interface InviteInfo {
  email: string;
  name: string | null;
  reset: boolean;
  workspace: string;
}

/** One-time link from an admin: join the workspace, or set a new password. */
export function InvitePage() {
  const { token } = useParams();
  const info = useQuery({ queryKey: ["invite", token], queryFn: () => api.get<InviteInfo>(`/auth/invite/${token}`), retry: false });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (info.isLoading) return <div className="p-8 text-zinc-400">Loading…</div>;
  if (info.error || !info.data)
    return (
      <AuthCard title="Link not valid" subtitle={info.error instanceof Error ? info.error.message : "This link is invalid or has expired."}>
        <a href="/" className="text-sm text-accent">
          Go to sign in
        </a>
      </AuthCard>
    );
  const inv = info.data;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError("Passwords don't match");
    setBusy(true);
    setError(null);
    try {
      await api.post(`/auth/invite/${token}`, { name: name || inv.name, password });
      location.assign("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title={inv.reset ? "Set a new password" : `Join ${inv.workspace} on Agentic PM`}
      subtitle={inv.reset ? `For ${inv.email}. Other devices will be signed out.` : `You're joining as ${inv.email}.`}
    >
      <form onSubmit={submit}>
        {!inv.reset && <Field label="Your name" defaultValue={inv.name ?? ""} onChange={(e) => setName(e.target.value)} required autoFocus />}
        <Field label="Password" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus={inv.reset} />
        <Field label="Confirm password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
        <Button variant="primary" className="w-full justify-center py-2" disabled={busy}>
          {busy ? "…" : inv.reset ? "Save password" : "Join"}
        </Button>
      </form>
    </AuthCard>
  );
}
