import { useState, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Camera, X, Upload } from "lucide-react";

interface ProfilePictureUploadProps {
  currentImageUrl?: string;
  gamertag: string;
}

export function ProfilePictureUpload({ currentImageUrl, gamertag }: ProfilePictureUploadProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      
      const response = await fetch('/api/user/profile-picture', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('Failed to upload profile picture');
      }

      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/auth/user'] });
      setPreviewUrl(null);
      setSelectedFile(null);
      toast({
        title: "Profile Picture Updated",
        description: "Your profile picture has been successfully updated.",
      });
    },
    onError: () => {
      toast({
        title: "Upload Failed",
        description: "Failed to upload profile picture. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        toast({
          title: "File Too Large",
          description: "Please select an image smaller than 5MB.",
          variant: "destructive",
        });
        return;
      }

      if (!file.type.startsWith('image/')) {
        toast({
          title: "Invalid File Type",
          description: "Please select an image file.",
          variant: "destructive",
        });
        return;
      }

      setSelectedFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setPreviewUrl(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleUpload = () => {
    if (selectedFile) {
      uploadMutation.mutate(selectedFile);
    }
  };

  const handleCancel = () => {
    setPreviewUrl(null);
    setSelectedFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const initials = gamertag.slice(0, 2).toUpperCase();
  const displayImageUrl = previewUrl || currentImageUrl;

  return (
    <Card data-testid="card-profile-picture-upload" className="relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-purple-500/5 pointer-events-none" />
      
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Camera className="h-5 w-5" />
          Profile Picture
        </CardTitle>
        <CardDescription>
          Upload a profile picture to personalize your account
        </CardDescription>
      </CardHeader>
      
      <CardContent className="space-y-4">
        <div className="flex flex-col items-center gap-4">
          <div className="relative group">
            <Avatar className="h-32 w-32 border-4 border-primary/20 transition-all duration-300 group-hover:border-primary/40 group-hover:scale-105">
              <AvatarImage src={displayImageUrl} alt={gamertag} />
              <AvatarFallback className="bg-primary text-primary-foreground text-3xl">
                {initials}
              </AvatarFallback>
            </Avatar>
            
            {!previewUrl && (
              <div className="absolute inset-0 bg-black/60 rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center">
                <Camera className="h-8 w-8 text-white" />
              </div>
            )}
          </div>

          {previewUrl ? (
            <div className="flex gap-2 animate-in fade-in slide-in-from-bottom-4 duration-300">
              <Button
                onClick={handleUpload}
                disabled={uploadMutation.isPending}
                className="gap-2"
                data-testid="button-upload-picture"
              >
                <Upload className="h-4 w-4" />
                {uploadMutation.isPending ? "Uploading..." : "Save Picture"}
              </Button>
              <Button
                onClick={handleCancel}
                variant="outline"
                disabled={uploadMutation.isPending}
                data-testid="button-cancel-upload"
              >
                <X className="h-4 w-4 mr-2" />
                Cancel
              </Button>
            </div>
          ) : (
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileSelect}
                className="hidden"
                id="profile-picture-input"
                data-testid="input-profile-picture"
              />
              <label htmlFor="profile-picture-input">
                <Button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  variant="outline"
                  className="gap-2"
                  data-testid="button-select-picture"
                >
                  <Camera className="h-4 w-4" />
                  Choose Picture
                </Button>
              </label>
            </div>
          )}
        </div>

        <p className="text-xs text-muted-foreground text-center">
          Supported formats: JPG, PNG, GIF, WebP (Max 5MB)
        </p>
      </CardContent>
    </Card>
  );
}
