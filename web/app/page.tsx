export default async function IndexPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const params = await searchParams;
  const page = params?.page ?? "1";
  return <p>ok — page {page}</p>;
}
