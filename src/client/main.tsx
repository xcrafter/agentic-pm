import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import "./index.css";
import { Layout } from "./pages/Layout";
import { BoardPage } from "./pages/Board";
import { TaskPage } from "./pages/Task";
import { InboxPage } from "./pages/Inbox";
import { ProjectsPage } from "./pages/Projects";
import { MemberPage, TeamPage } from "./pages/Team";
import { WorkspacePage } from "./pages/Workspace";
import { InvitePage } from "./pages/Invite";
import { SettingsPage } from "./pages/Settings";
import { UpdatesPage } from "./pages/Updates";
import { ReportsPage } from "./pages/Reports";
import { IdeasPage } from "./pages/Ideas";

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: true, retry: 1 } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="invite/:token" element={<InvitePage />} />
          <Route element={<Layout />}>
            <Route index element={<BoardPage />} />
            <Route path="my" element={<BoardPage mine />} />
            <Route path="inbox" element={<InboxPage />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="projects/:projectId" element={<BoardPage />} />
            <Route path="workspace" element={<WorkspacePage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="feed" element={<UpdatesPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="ideas" element={<IdeasPage />} />
            <Route path="team" element={<TeamPage />} />
            <Route path="team/:handle" element={<MemberPage />} />
            <Route path="members" element={<Navigate to="/team" replace />} />
            <Route path="t/:taskKey" element={<TaskPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
