import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { 
  Home, 
  Plus, 
  User, 
  MessageCircle, 
  Settings,
  LogOut,
  Menu,
  X,
  Users,
  Search,
  MoreVertical
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { ThemeSelector } from "./ThemeSelector";
import { NotificationBell } from "./NotificationBell";

interface GameNavigationProps {
  currentPage: "home" | "search" | "create" | "profile" | "messages" | "settings" | "profile-setup" | "connections";
  onNavigate: (page: string) => void;
  user?: {
    gamertag: string;
    profileImageUrl?: string;
  };
  onLogout?: () => void;
  pendingMessages?: number;
}

export function GameNavigation({ 
  currentPage, 
  onNavigate, 
  user, 
  onLogout,
  pendingMessages = 0 
}: GameNavigationProps) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const navigationItems = [
    { id: "home", label: "Feed", icon: Home },
    { id: "search", label: "Discover", icon: Search },
    { id: "connections", label: "Matches", icon: Users },
    { id: "messages", label: "Messages", icon: MessageCircle, badge: pendingMessages },
    { id: "profile", label: "Profile", icon: User },
  ];

  const NavItem = ({ item, isMobile = false }: { item: typeof navigationItems[0], isMobile?: boolean }) => {
    const isActive = currentPage === item.id;
    const Icon = item.icon;
    
    return (
      <Button
        variant={isActive ? "default" : "ghost"}
        size={isMobile ? "default" : "sm"}
        onClick={() => {
          onNavigate(item.id);
          if (isMobile) setIsMobileMenuOpen(false);
        }}
        className={cn(
          "relative",
          isMobile ? "justify-start w-full" : "flex-col h-16 w-16",
          isActive && "bg-primary text-primary-foreground"
        )}
        data-testid={`nav-${item.id}`}
      >
        <Icon className={cn("h-5 w-5", isMobile && "mr-3")} />
        {isMobile && <span>{item.label}</span>}
        {!isMobile && <span className="text-xs mt-1">{item.label}</span>}
        {item.badge && item.badge > 0 && (
          <Badge 
            variant="destructive" 
            className={cn(
              "absolute text-xs px-1 py-0 min-w-[16px] h-4",
              isMobile ? "-top-1 -right-1" : "-top-2 -right-2"
            )}
          >
            {item.badge > 99 ? "99+" : item.badge}
          </Badge>
        )}
      </Button>
    );
  };

  return (
    <>
      {/* Desktop Sidebar */}
      <nav className="hidden md:flex fixed left-0 top-0 h-full w-20 bg-card border-r border-card-border flex-col items-center py-6 z-50">
        <div className="mb-8">
          <div className="w-10 h-10 bg-primary rounded-lg flex items-center justify-center">
            <span className="text-primary-foreground font-bold text-lg">GM</span>
          </div>
        </div>

        <div className="flex flex-col gap-2 flex-1">
          {navigationItems.map((item) => (
            <NavItem key={item.id} item={item} />
          ))}
        </div>

        <div className="flex flex-col gap-2">
          {user && (
            <div className="flex items-center justify-center mb-2">
              <Avatar className="h-10 w-10 border-2 border-primary/30 hover:border-primary/60 transition-all duration-300 hover:scale-110 cursor-pointer" onClick={() => onNavigate('profile')}>
                <AvatarImage src={user.profileImageUrl} alt={user.gamertag} />
                <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                  {user.gamertag.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
            </div>
          )}
          
          <div className="flex items-center justify-center">
            <NotificationBell />
          </div>
          
          <div className="flex items-center justify-center">
            <ThemeSelector />
          </div>
          
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="flex-col h-16 w-16"
                data-testid="nav-menu"
              >
                <MoreVertical className="h-5 w-5" />
                <span className="text-xs mt-1">Menu</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onClick={() => onNavigate('settings')} data-testid="nav-settings">
                <Settings className="h-4 w-4 mr-2" />
                Settings
              </DropdownMenuItem>
              {user && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onLogout} data-testid="nav-logout">
                    <LogOut className="h-4 w-4 mr-2" />
                    Logout
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </nav>

      {/* Mobile Header */}
      <header className="md:hidden fixed top-0 left-0 right-0 h-16 bg-card border-b border-card-border flex items-center justify-between px-4 z-50">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-primary rounded-md flex items-center justify-center">
            <span className="text-primary-foreground font-bold text-sm">GM</span>
          </div>
          <h1 className="font-bold text-lg text-foreground">GameMatch</h1>
        </div>

        <div className="flex items-center gap-3">
          {user && (
            <Avatar className="h-8 w-8">
              <AvatarImage src={user.profileImageUrl} alt={user.gamertag} />
              <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                {user.gamertag.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          )}
          
          <NotificationBell />
          
          <ThemeSelector />
          
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            data-testid="button-mobile-menu"
          >
            {isMobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
        </div>
      </header>

      {/* Mobile Menu Overlay */}
      {isMobileMenuOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-background/80 backdrop-blur-sm">
          <div className="fixed right-0 top-16 h-[calc(100vh-4rem)] w-64 bg-card border-l border-card-border p-4">
            <div className="space-y-2">
              {navigationItems.map((item) => (
                <NavItem key={item.id} item={item} isMobile />
              ))}
              
              <div className="border-t border-border pt-4 mt-4 space-y-2">
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-sm font-medium">Theme</span>
                  <ThemeSelector />
                </div>
                
                <Button
                  variant="ghost"
                  onClick={() => {
                    onNavigate('settings');
                    setIsMobileMenuOpen(false);
                  }}
                  className="justify-start w-full"
                  data-testid="nav-settings-mobile"
                >
                  <Settings className="h-5 w-5 mr-3" />
                  Settings
                </Button>
                
                {user && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      onLogout?.();
                      setIsMobileMenuOpen(false);
                    }}
                    className="justify-start w-full text-destructive hover:text-destructive"
                    data-testid="nav-logout-mobile"
                  >
                    <LogOut className="h-5 w-5 mr-3" />
                    Logout
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Bottom Navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 h-16 bg-card border-t border-card-border flex items-center justify-around z-50">
        {navigationItems.slice(0, 5).map((item) => {
          const isActive = currentPage === item.id;
          const Icon = item.icon;
          
          return (
            <Button
              key={item.id}
              variant="ghost"
              size="sm"
              onClick={() => onNavigate(item.id)}
              className={cn(
                "relative flex-col h-12 w-12 p-0",
                isActive && "text-primary"
              )}
              data-testid={`nav-mobile-${item.id}`}
            >
              <Icon className="h-5 w-5" />
              <span className="text-xs mt-1">{item.label}</span>
              {item.badge && item.badge > 0 && (
                <Badge 
                  variant="destructive" 
                  className="absolute -top-1 -right-1 text-xs px-1 py-0 min-w-[16px] h-4"
                >
                  {item.badge > 99 ? "99+" : item.badge}
                </Badge>
              )}
            </Button>
          );
        })}
      </nav>
    </>
  );
}