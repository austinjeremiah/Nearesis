import Link from "next/link";

const SCENARIOS = ["baseline", "hostile", "large", "corrupt", "graph", "gaps", "empty"];

export default function Home() {
  return (
    <main className="home">
      <h1>Nearesis</h1>
      <p className="muted">
        Fixture workspaces (SYNTHETIC data, clearly labelled). Live workspaces open through the kernel.
      </p>
      <ul>
        {SCENARIOS.map((s) => (
          <li key={s}>
            <Link href={`/w/fixture?scenario=${s}`}>{s}</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
