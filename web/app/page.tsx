import { readOntology } from "@/lib/readOntology";

export default async function IndexPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const page = params?.page ?? "1";
  const ontology = readOntology();
  return <p>ok — page {page} — {ontology.axes.length} axes</p>;
}
