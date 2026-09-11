import Link from "next/link";

import { PageHeader } from "@/components/layout/PageHeader";

export default function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" description="That route does not exist in this dashboard." />
      <Link href="/" className="btn btn-primary">
        Back to overview
      </Link>
    </>
  );
}
