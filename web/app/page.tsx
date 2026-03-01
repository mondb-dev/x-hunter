import { readOntology } from "@/lib/readOntology";
import { getAllJournalDays } from "@/lib/readJournals";

export default async function IndexPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const page = params?.page ?? "1";
  const ontology = readOntology();
  const days = getAllJournalDays();
  return <p>ok — page {page} — {ontology.axes.length} axes — {days.length} days</p>;
}
