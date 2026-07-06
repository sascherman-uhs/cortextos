import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { CosmosClient } from './cosmos-client';

// Full-screen immersive Cosmos route. Lives OUTSIDE the (dashboard) route
// group so it does not inherit DashboardShell — but replicates the same
// session guard the DashboardLayout enforces.
export default async function JarvisCosmosPage() {
  const session = await auth();
  if (!session) redirect('/login');

  return (
    <main className="h-screen w-screen overflow-hidden">
      <CosmosClient />
    </main>
  );
}
