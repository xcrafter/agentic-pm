import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import "./index.css";
import { Layout } from "./pages/Layout";
import { BoardPage } from "./pages/Board";
import { TaskPage } from "./pages/Task";
import { InboxPage } from "./pages/Inbox";
import { ProjectsPage } from "./pages/Projects";
import { MembersPage } from "./pages/Members";

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: true, retry: 1 } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<BoardPage />} />
            <Route path="my" element={<BoardPage mine />} />
            <Route path="inbox" element={<InboxPage />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="projects/:projectId" element={<BoardPage />} />
            <Route path="members" element={<MembersPage />} />
            <Route path="t/:taskKey" element={<TaskPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
