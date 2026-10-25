import { Suspense } from "react";
import { WorkflowPage } from "@/components/process/workflow-page";

// cacheComponents: useParams on an unknown id must stream inside a Suspense boundary
export default function Page() {
  return <Suspense><WorkflowPage /></Suspense>;
}
