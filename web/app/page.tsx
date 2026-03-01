import { readOntology } from "@/lib/readOntology";

export default async function IndexPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const page = params?.page ?? "1";
  const ontology = readOntology();

  let daysLen = -1;
  let importErr = "";
  try {
    const { getAllJournalDays } = await import("@/lib/readJournals");
    daysLen = getAllJournalDays().length;
  } catch (err: unknown) {
    importErr = String(err);
  }

  return <p>ok — {page} — {ontology.axes.length} axes — days:{daysLen} err:{importErr}</p>;
}
