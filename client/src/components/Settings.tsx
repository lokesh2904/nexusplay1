import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { PrivacySettings } from "./PrivacySettings";
import { Users as UsersIcon } from "lucide-react";
import type { User } from "@shared/schema";

interface SettingsProps {
  user?: User | null;
}

export function Settings({ user }: SettingsProps) {
  // Fetch total user count
  const { data: userCount, isLoading: isLoadingCount } = useQuery<number>({
    queryKey: ['/api/users/count'],
    queryFn: async () => {
      const response = await fetch('/api/users/count');
      if (!response.ok) {
        throw new Error('Failed to fetch user count');
      }
      return response.json();
    },
    retry: false,
  });

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-foreground mb-6">Settings</h1>
      
      <div className="space-y-6">
        {/* User Count */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UsersIcon className="h-5 w-5" />
              Platform Statistics
            </CardTitle>
            <CardDescription>Total active users on GameMatch</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-primary" data-testid="text-user-count">
              {isLoadingCount ? "..." : userCount?.toLocaleString() || "0"}
            </div>
            <p className="text-sm text-muted-foreground mt-1">Total users</p>
          </CardContent>
        </Card>

        {/* Privacy Settings */}
        {user && <PrivacySettings userId={user.id} />}

        {/* Appearance */}
        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>Theme can be changed from the navigation menu</CardDescription>
          </CardHeader>
        </Card>

        {/* Notifications */}
        <Card>
          <CardHeader>
            <CardTitle>Notifications</CardTitle>
            <CardDescription>Notification preferences coming soon</CardDescription>
          </CardHeader>
        </Card>
      </div>
    </div>
  );
}
