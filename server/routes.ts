import type { Express } from "express";
import express from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { setupAuth, isAuthenticated, getSession } from "./googleAuth";
import { devAuthMiddleware, ensureDevUser } from "./devAuth";
import { insertMatchRequestSchema, registerUserSchema, type RegisterUser } from "@shared/schema";
import { z } from "zod";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Development mode flag - bypass authentication when explicitly enabled
const DEV_MODE = process.env.AUTH_DISABLED === "true";

// Choose authentication middleware based on mode
const authMiddleware = DEV_MODE ? devAuthMiddleware : isAuthenticated;

export async function registerRoutes(app: Express): Promise<Server> {
  // Setup authentication (skip in dev mode)
  if (DEV_MODE) {
    console.log("\n🔓 [DEV MODE] Authentication is DISABLED for development");
    console.log("   All routes will use a mock development user");
    console.log("   To enable authentication: Remove AUTH_DISABLED from secrets or set to 'false'\n");
    await ensureDevUser();
  } else {
    console.log("\n🔐 [PRODUCTION MODE] Authentication is ENABLED");
    console.log("   Google OAuth is required for all protected routes\n");
    await setupAuth(app);
  }

  // Auth routes
  app.get('/api/auth/user', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const user = await storage.getUser(userId);
      res.json(user);
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });
  
  // Local registration endpoint
  app.post('/api/auth/register', async (req: any, res) => {
    try {
      const validatedData = registerUserSchema.parse(req.body);
      
      const existingUser = await storage.getUserByGamertag(validatedData.gamertag);
      if (existingUser) {
        return res.status(400).json({ message: "Gamertag already taken" });
      }
      
      const user = await storage.createLocalUser(validatedData);
      
      req.login(user, (err: any) => {
        if (err) {
          console.error("Error logging in after registration:", err);
          return res.status(500).json({ message: "Registration successful but login failed" });
        }
        res.status(201).json(user);
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid registration data", errors: error.errors });
      } else if ((error as any).code === '23505') {
        res.status(400).json({ message: "Gamertag or email already taken" });
      } else {
        console.error("Error registering user:", error);
        res.status(500).json({ message: "Failed to register user" });
      }
    }
  });
  
  // Local login endpoint
  app.post('/api/auth/login', async (req: any, res) => {
    try {
      const { gamertag } = req.body;
      
      if (!gamertag) {
        return res.status(400).json({ message: "Gamertag is required" });
      }
      
      const user = await storage.getUserByGamertag(gamertag);
      if (!user) {
        return res.status(401).json({ message: "User not found" });
      }
      
      req.login(user, (err: any) => {
        if (err) {
          console.error("Error logging in:", err);
          return res.status(500).json({ message: "Login failed" });
        }
        res.json(user);
      });
    } catch (error) {
      console.error("Error logging in:", error);
      res.status(500).json({ message: "Failed to log in" });
    }
  });

  // User discovery routes
  app.get('/api/users', async (req, res) => {
    try {
      const { search, gender, language, game, latitude, longitude, maxDistance } = req.query as Record<string, string>;
      const filters: any = { search, gender, language, game };
      
      // Parse location filters
      if (latitude) filters.latitude = parseFloat(latitude);
      if (longitude) filters.longitude = parseFloat(longitude);
      if (maxDistance) filters.maxDistance = parseFloat(maxDistance);
      
      const users = await storage.getAllUsers(filters);
      res.json(users);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ message: "Failed to fetch users" });
    }
  });

  // User count endpoint
  app.get('/api/users/count', async (req, res) => {
    try {
      const count = await storage.getUserCount();
      res.json(count);
    } catch (error) {
      console.error("Error fetching user count:", error);
      res.status(500).json({ message: "Failed to fetch user count" });
    }
  });

  // Match request routes
  app.get('/api/match-requests', async (req, res) => {
    try {
      const { game, mode, region, gender, language, latitude, longitude, maxDistance } = req.query as Record<string, string>;
      const filters: any = { game, mode, region, gender, language };
      
      // Parse location filters
      if (latitude) filters.latitude = parseFloat(latitude);
      if (longitude) filters.longitude = parseFloat(longitude);
      if (maxDistance) filters.maxDistance = parseFloat(maxDistance);
      
      const matchRequests = await storage.getMatchRequests(filters);
      res.json(matchRequests);
    } catch (error) {
      console.error("Error fetching match requests:", error);
      res.status(500).json({ message: "Failed to fetch match requests" });
    }
  });

  app.post('/api/match-requests', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const validatedData = insertMatchRequestSchema.parse(req.body);
      
      const matchRequest = await storage.createMatchRequest({
        ...validatedData,
        userId,
      });
      
      // Get user info for the broadcast message
      const user = await storage.getUser(userId);
      const displayName = user?.gamertag || user?.firstName || 'A player';
      
      // Broadcast new match request to all users
      (app as any).broadcast?.toAll({
        type: 'match_request_created',
        data: matchRequest,
        message: `New ${matchRequest.gameName} ${matchRequest.gameMode} match request from ${displayName}`
      });
      
      res.status(201).json(matchRequest);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid request data", errors: error.errors });
      } else {
        console.error("Error creating match request:", error);
        res.status(500).json({ message: "Failed to create match request" });
      }
    }
  });

  app.patch('/api/match-requests/:id/status', authMiddleware, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
      const userId = req.user.id;
      
      if (!['waiting', 'connected', 'declined'].includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }
      
      // First check if the match request exists and verify ownership
      const existingRequest = await storage.getMatchRequests();
      const requestToUpdate = existingRequest.find(r => r.id === id);
      
      if (!requestToUpdate) {
        return res.status(404).json({ message: "Match request not found" });
      }
      
      if (requestToUpdate.userId !== userId) {
        return res.status(403).json({ message: "You can only update your own match requests" });
      }
      
      const updatedRequest = await storage.updateMatchRequestStatus(id, status);
      
      // Broadcast match request status update
      (app as any).broadcast?.toAll({
        type: 'match_request_updated',
        data: updatedRequest,
        message: `Match request status updated to ${status}`
      });
      
      res.json(updatedRequest);
    } catch (error) {
      console.error("Error updating match request:", error);
      res.status(500).json({ message: "Failed to update match request" });
    }
  });

  // Get single match request by ID
  app.get('/api/match-requests/:id', authMiddleware, async (req: any, res) => {
    try {
      const { id } = req.params;
      
      const matchRequests = await storage.getMatchRequests();
      const matchRequest = matchRequests.find(r => r.id === id);
      
      if (!matchRequest) {
        return res.status(404).json({ message: "Match request not found" });
      }
      
      res.json(matchRequest);
    } catch (error) {
      console.error("Error fetching match request:", error);
      res.status(500).json({ message: "Failed to fetch match request" });
    }
  });

  app.delete('/api/match-requests/:id', authMiddleware, async (req: any, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;
      
      // First check if the match request exists and verify ownership
      const existingRequest = await storage.getMatchRequests();
      const requestToDelete = existingRequest.find(r => r.id === id);
      
      if (!requestToDelete) {
        return res.status(404).json({ message: "Match request not found" });
      }
      
      if (requestToDelete.userId !== userId) {
        return res.status(403).json({ message: "You can only delete your own match requests" });
      }
      
      await storage.deleteMatchRequest(id);
      
      // Broadcast match request deletion to all users
      (app as any).broadcast?.toAll({
        type: 'match_request_deleted',
        data: { id },
        message: `Match request deleted`
      });
      
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting match request:", error);
      res.status(500).json({ message: "Failed to delete match request" });
    }
  });

  // Match connection routes
  app.post('/api/match-connections', authMiddleware, async (req: any, res) => {
    try {
      const requesterId = req.user.id;
      const { requestId, accepterId } = req.body;
      
      // Validation
      if (!requestId || !accepterId) {
        return res.status(400).json({ message: "requestId and accepterId are required" });
      }
      
      // Prevent self-connections
      if (requesterId === accepterId) {
        return res.status(400).json({ message: "You cannot connect to your own match request" });
      }
      
      // Verify the match request exists
      const matchRequests = await storage.getMatchRequests();
      const matchRequest = matchRequests.find(r => r.id === requestId);
      
      if (!matchRequest) {
        return res.status(404).json({ message: "Match request not found" });
      }
      
      // Verify accepterId matches the owner of the match request
      if (matchRequest.userId !== accepterId) {
        return res.status(400).json({ message: "accepterId must be the owner of the match request" });
      }
      
      // Check for existing connection to prevent duplicates
      const existingConnections = await storage.getUserConnections(requesterId);
      const duplicateConnection = existingConnections.find(c => 
        c.requestId === requestId && c.accepterId === accepterId
      );
      
      if (duplicateConnection) {
        return res.status(400).json({ message: "Connection already exists for this match request" });
      }
      
      const connection = await storage.createMatchConnection({
        requestId,
        requesterId,
        accepterId,
      });
      
      // Notify the accepter that someone applied to their match
      const requesterUser = await storage.getUser(requesterId);
      const notification = await storage.createNotification({
        userId: accepterId,
        type: "match_application",
        title: "New Match Application",
        message: `${requesterUser?.gamertag || "Someone"} wants to join your ${matchRequest.gameName} ${matchRequest.gameMode} match`,
        relatedUserId: requesterId,
        relatedMatchId: requestId,
        isRead: "false",
      });
      
      // Broadcast notification in real-time
      (app as any).broadcast?.toUsers([accepterId], {
        type: 'new_notification',
        data: notification
      });
      
      // Broadcast match connection to both users
      (app as any).broadcast?.toUsers([requesterId, accepterId], {
        type: 'match_connection_created',
        data: connection,
        message: `New match connection created`
      });
      
      res.status(201).json(connection);
    } catch (error) {
      console.error("Error creating match connection:", error);
      res.status(500).json({ message: "Failed to create match connection" });
    }
  });

  app.patch('/api/match-connections/:id/status', authMiddleware, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
      const userId = req.user.id;
      
      if (!['pending', 'accepted', 'declined'].includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }
      
      // First check if the connection exists and verify user is a participant
      const userConnections = await storage.getUserConnections(userId);
      const connectionToUpdate = userConnections.find(c => c.id === id);
      
      if (!connectionToUpdate) {
        return res.status(404).json({ message: "Match connection not found or you are not authorized to modify it" });
      }
      
      const updatedConnection = await storage.updateMatchConnectionStatus(id, status);
      
      // Notify the requester of the status change
      if (status === 'accepted') {
        const accepterUser = await storage.getUser(connectionToUpdate.accepterId);
        const notification = await storage.createNotification({
          userId: connectionToUpdate.requesterId,
          type: "match_accepted",
          title: "Match Application Accepted",
          message: `${accepterUser?.gamertag || "Someone"} accepted your match application`,
          relatedUserId: connectionToUpdate.accepterId,
          relatedMatchId: connectionToUpdate.requestId,
          isRead: "false",
        });
        
        // Broadcast notification in real-time
        (app as any).broadcast?.toUsers([connectionToUpdate.requesterId], {
          type: 'new_notification',
          data: notification
        });
      } else if (status === 'declined') {
        const accepterUser = await storage.getUser(connectionToUpdate.accepterId);
        const notification = await storage.createNotification({
          userId: connectionToUpdate.requesterId,
          type: "match_declined",
          title: "Match Application Declined",
          message: `${accepterUser?.gamertag || "Someone"} declined your match application`,
          relatedUserId: connectionToUpdate.accepterId,
          relatedMatchId: connectionToUpdate.requestId,
          isRead: "false",
        });
        
        // Broadcast notification in real-time
        (app as any).broadcast?.toUsers([connectionToUpdate.requesterId], {
          type: 'new_notification',
          data: notification
        });
      }
      
      // Broadcast connection status update to participants
      (app as any).broadcast?.toUsers([connectionToUpdate.requesterId, connectionToUpdate.accepterId], {
        type: 'match_connection_updated',
        data: updatedConnection,
        message: `Match connection status updated to ${status}`
      });
      
      res.json(updatedConnection);
    } catch (error) {
      console.error("Error updating match connection:", error);
      res.status(500).json({ message: "Failed to update match connection" });
    }
  });

  app.get('/api/user/connections', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const connections = await storage.getUserConnections(userId);
      res.json(connections);
    } catch (error) {
      console.error("Error fetching user connections:", error);
      res.status(500).json({ message: "Failed to fetch user connections" });
    }
  });

  // Connection request routes (direct user-to-user, no match required)
  app.post('/api/connection-requests', authMiddleware, async (req: any, res) => {
    try {
      const senderId = req.user.id;
      const { receiverId } = req.body;
      
      if (!receiverId) {
        return res.status(400).json({ message: "receiverId is required" });
      }
      
      if (senderId === receiverId) {
        return res.status(400).json({ message: "You cannot send a connection request to yourself" });
      }
      
      const existingRequests = await storage.getConnectionRequests(senderId);
      const duplicateRequest = existingRequests.find(r => 
        r.status === 'pending' &&
        ((r.senderId === senderId && r.receiverId === receiverId) ||
        (r.senderId === receiverId && r.receiverId === senderId))
      );
      
      if (duplicateRequest) {
        return res.status(400).json({ message: "Connection request already exists" });
      }
      
      const request = await storage.createConnectionRequest({
        senderId,
        receiverId,
      });
      
      (app as any).broadcast?.toUsers([senderId, receiverId], {
        type: 'connection_request_created',
        data: request,
        message: 'New connection request created'
      });
      
      res.status(201).json(request);
    } catch (error) {
      console.error("Error creating connection request:", error);
      res.status(500).json({ message: "Failed to create connection request" });
    }
  });

  app.patch('/api/connection-requests/:id/status', authMiddleware, async (req: any, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
      const userId = req.user.id;
      
      if (!['pending', 'accepted', 'declined'].includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }
      
      const userRequests = await storage.getConnectionRequests(userId);
      const requestToUpdate = userRequests.find(r => r.id === id);
      
      if (!requestToUpdate) {
        return res.status(404).json({ message: "Connection request not found or you are not authorized to modify it" });
      }
      
      // If declined, delete the request and notify sender
      if (status === 'declined') {
        await storage.deleteConnectionRequest(id, userId);
        
        // Notify the sender that their request was declined
        const receiverUser = await storage.getUser(requestToUpdate.receiverId);
        const notification = await storage.createNotification({
          userId: requestToUpdate.senderId,
          type: "connection_declined",
          title: "Connection Request Declined",
          message: `${receiverUser?.gamertag || "Someone"} declined your connection request`,
          relatedUserId: requestToUpdate.receiverId,
          isRead: "false",
        });
        
        // Broadcast notification in real-time
        (app as any).broadcast?.toUsers([requestToUpdate.senderId], {
          type: 'new_notification',
          data: notification
        });
        
        (app as any).broadcast?.toUsers([requestToUpdate.senderId, requestToUpdate.receiverId], {
          type: 'connection_request_deleted',
          data: { id },
          message: 'Connection request declined and removed'
        });
        
        return res.status(204).send();
      }
      
      const updatedRequest = await storage.updateConnectionRequestStatus(id, status);
      
      // If accepted, notify the sender
      if (status === 'accepted') {
        const receiverUser = await storage.getUser(requestToUpdate.receiverId);
        const notification = await storage.createNotification({
          userId: requestToUpdate.senderId,
          type: "connection_accepted",
          title: "Connection Request Accepted",
          message: `${receiverUser?.gamertag || "Someone"} accepted your connection request`,
          relatedUserId: requestToUpdate.receiverId,
          isRead: "false",
        });
        
        // Broadcast notification in real-time
        (app as any).broadcast?.toUsers([requestToUpdate.senderId], {
          type: 'new_notification',
          data: notification
        });
      }
      
      (app as any).broadcast?.toUsers([requestToUpdate.senderId, requestToUpdate.receiverId], {
        type: 'connection_request_updated',
        data: updatedRequest,
        message: `Connection request status updated to ${status}`
      });
      
      res.json(updatedRequest);
    } catch (error) {
      console.error("Error updating connection request:", error);
      res.status(500).json({ message: "Failed to update connection request" });
    }
  });

  app.get('/api/connection-requests', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const requests = await storage.getConnectionRequests(userId);
      res.json(requests);
    } catch (error) {
      console.error("Error fetching connection requests:", error);
      res.status(500).json({ message: "Failed to fetch connection requests" });
    }
  });

  app.delete('/api/connection-requests/:id', authMiddleware, async (req: any, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;
      
      // Get the request details before deleting to broadcast to both users
      const userRequests = await storage.getConnectionRequests(userId);
      const requestToDelete = userRequests.find(r => r.id === id);
      
      if (!requestToDelete) {
        return res.status(404).json({ message: 'Connection request not found or you are not authorized to delete it' });
      }
      
      await storage.deleteConnectionRequest(id, userId);
      
      // Broadcast to both sender and receiver
      (app as any).broadcast?.toUsers([requestToDelete.senderId, requestToDelete.receiverId], {
        type: 'connection_request_deleted',
        data: { id },
        message: 'Connection request deleted'
      });
      
      res.status(204).send();
    } catch (error: any) {
      console.error("Error deleting connection request:", error);
      if (error.message === 'Connection request not found') {
        return res.status(404).json({ message: error.message });
      }
      if (error.message === 'Unauthorized to delete this connection request') {
        return res.status(403).json({ message: error.message });
      }
      res.status(500).json({ message: "Failed to delete connection request" });
    }
  });

  app.delete('/api/match-connections/:id', authMiddleware, async (req: any, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;
      
      // Get the connection details before deleting to broadcast to both users
      const userConnections = await storage.getUserConnections(userId);
      const connectionToDelete = userConnections.find(c => c.id === id);
      
      if (!connectionToDelete) {
        return res.status(404).json({ message: 'Match connection not found or you are not authorized to delete it' });
      }
      
      await storage.deleteMatchConnection(id, userId);
      
      // Broadcast to both requester and accepter
      (app as any).broadcast?.toUsers([connectionToDelete.requesterId, connectionToDelete.accepterId], {
        type: 'match_connection_deleted',
        data: { id },
        message: 'Match connection deleted'
      });
      
      res.status(204).send();
    } catch (error: any) {
      console.error("Error deleting match connection:", error);
      if (error.message === 'Match connection not found') {
        return res.status(404).json({ message: error.message });
      }
      if (error.message === 'Unauthorized to delete this match connection') {
        return res.status(403).json({ message: error.message });
      }
      res.status(500).json({ message: "Failed to delete match connection" });
    }
  });

  // User profile routes
  app.get('/api/users/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      const user = await storage.getUser(userId);
      
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }
      
      res.json(user);
    } catch (error) {
      console.error("Error fetching user profile:", error);
      res.status(500).json({ message: "Failed to fetch user profile" });
    }
  });

  app.patch('/api/user/profile', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const profileData = req.body;
      
      const updatedUser = await storage.updateUserProfile(userId, profileData);
      res.json(updatedUser);
    } catch (error) {
      console.error("Error updating user profile:", error);
      res.status(500).json({ message: "Failed to update user profile" });
    }
  });

  app.patch('/api/user/privacy', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { updatePrivacySettingsSchema } = await import("@shared/schema");
      
      const validatedSettings = updatePrivacySettingsSchema.parse(req.body);
      const updatedUser = await storage.updatePrivacySettings(userId, validatedSettings);
      
      res.json(updatedUser);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Invalid privacy settings", errors: error.errors });
      } else {
        console.error("Error updating privacy settings:", error);
        res.status(500).json({ message: "Failed to update privacy settings" });
      }
    }
  });

  // Photo upload route
  // Create uploads directory if it doesn't exist
  const uploadsDir = path.join(__dirname, '../uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const storage_multer = multer.diskStorage({
    destination: (req: any, file: any, cb: any) => {
      cb(null, uploadsDir);
    },
    filename: (req: any, file: any, cb: any) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, uniqueSuffix + path.extname(file.originalname));
    }
  });

  const upload = multer({
    storage: storage_multer,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req: any, file: any, cb: any) => {
      const allowedTypes = /jpeg|jpg|png|gif|webp/;
      const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
      const mimetype = allowedTypes.test(file.mimetype);

      if (mimetype && extname) {
        return cb(null, true);
      }
      cb(new Error('Only image files are allowed!'));
    }
  });

  // Serve uploaded files statically
  app.use('/uploads', express.static(uploadsDir));

  app.post('/api/upload-photo', authMiddleware, upload.single('file'), async (req: any, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded' });
      }

      const fileUrl = `/uploads/${req.file.filename}`;
      res.json({ url: fileUrl });
    } catch (error: any) {
      console.error('Error uploading photo:', error);
      res.status(500).json({ message: error.message || 'Failed to upload photo' });
    }
  });

  app.post('/api/user/profile-picture', authMiddleware, upload.single('file'), async (req: any, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded' });
      }

      const userId = req.user.id;
      const fileUrl = `/uploads/${req.file.filename}`;
      
      const updatedUser = await storage.updateUserProfile(userId, { profileImageUrl: fileUrl });
      res.json(updatedUser);
    } catch (error: any) {
      console.error('Error uploading profile picture:', error);
      res.status(500).json({ message: error.message || 'Failed to upload profile picture' });
    }
  });

  // Game profile routes
  // Get all game profiles for a user
  app.get('/api/users/:userId/game-profiles', async (req, res) => {
    try {
      const { userId } = req.params;
      const profiles = await storage.getUserGameProfiles(userId);
      res.json(profiles);
    } catch (error: any) {
      console.error('Error fetching game profiles:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Create a new game profile
  app.post('/api/game-profiles', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const profile = await storage.createGameProfile({
        ...req.body,
        userId,
      });
      res.status(201).json(profile);
    } catch (error: any) {
      console.error('Error creating game profile:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Update a game profile
  app.patch('/api/game-profiles/:id', authMiddleware, async (req: any, res) => {
    try {
      const { id } = req.params;
      const profile = await storage.getGameProfile(id);
      
      if (!profile) {
        return res.status(404).json({ error: 'Game profile not found' });
      }
      
      if (profile.userId !== req.user.id) {
        return res.status(403).json({ error: 'Unauthorized' });
      }
      
      const updatedProfile = await storage.updateGameProfile(id, req.body);
      res.json(updatedProfile);
    } catch (error: any) {
      console.error('Error updating game profile:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Delete a game profile
  app.delete('/api/game-profiles/:id', authMiddleware, async (req: any, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;
      await storage.deleteGameProfile(id, userId);
      res.status(204).send();
    } catch (error: any) {
      console.error('Error deleting game profile:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Hobbies/Interests routes
  app.get('/api/users/:userId/hobbies', async (req, res) => {
    try {
      const { userId } = req.params;
      const { category } = req.query;
      const hobbies = await storage.getUserHobbies(userId, category as string);
      res.json(hobbies);
    } catch (error: any) {
      console.error('Error fetching hobbies:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/hobbies', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const hobbyData = { ...req.body, userId };
      const hobby = await storage.createHobby(hobbyData);
      res.status(201).json(hobby);
    } catch (error: any) {
      console.error('Error creating hobby:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch('/api/hobbies/:id', authMiddleware, async (req: any, res) => {
    try {
      const { id } = req.params;
      const hobby = await storage.getHobby(id);
      
      if (!hobby) {
        return res.status(404).json({ error: 'Hobby not found' });
      }
      
      if (hobby.userId !== req.user.id) {
        return res.status(403).json({ error: 'Unauthorized' });
      }
      
      const updatedHobby = await storage.updateHobby(id, req.body);
      res.json(updatedHobby);
    } catch (error: any) {
      console.error('Error updating hobby:', error);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete('/api/hobbies/:id', authMiddleware, async (req: any, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;
      await storage.deleteHobby(id, userId);
      res.status(204).send();
    } catch (error: any) {
      console.error('Error deleting hobby:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Mutuals routes
  app.get('/api/mutuals/:userId', authMiddleware, async (req: any, res) => {
    try {
      const currentUserId = req.user.id;
      const { userId } = req.params;
      
      // Get user privacy settings
      const targetUser = await storage.getUser(userId);
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }
      
      // Check if users are connected
      const connections = await storage.getUserConnections(currentUserId);
      const isConnected = connections.some(c => 
        (c.requesterId === userId || c.accepterId === userId) && c.status === 'accepted'
      );
      
      const result: any = {};
      
      // Apply privacy settings
      if (targetUser.showMutualGames === 'everyone' || 
          (targetUser.showMutualGames === 'connections' && isConnected)) {
        result.mutualGames = await storage.getMutualGames(currentUserId, userId);
      }
      
      if (targetUser.showMutualFriends === 'everyone' || 
          (targetUser.showMutualFriends === 'connections' && isConnected)) {
        result.mutualFriends = await storage.getMutualFriends(currentUserId, userId);
      }
      
      if (targetUser.showMutualHobbies === 'everyone' || 
          (targetUser.showMutualHobbies === 'connections' && isConnected)) {
        result.mutualHobbies = await storage.getMutualHobbies(currentUserId, userId);
      }
      
      res.json(result);
    } catch (error: any) {
      console.error('Error calculating mutuals:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Hidden matches routes
  app.get('/api/hidden-matches', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const hiddenIds = await storage.getHiddenMatchIds(userId);
      res.json(hiddenIds);
    } catch (error) {
      console.error("Error fetching hidden matches:", error);
      res.status(500).json({ message: "Failed to fetch hidden matches" });
    }
  });

  app.post('/api/hidden-matches', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { matchRequestId } = req.body;
      
      if (!matchRequestId) {
        return res.status(400).json({ message: "matchRequestId is required" });
      }
      
      const hidden = await storage.hideMatchRequest(userId, matchRequestId);
      res.status(201).json(hidden);
    } catch (error) {
      console.error("Error hiding match request:", error);
      res.status(500).json({ message: "Failed to hide match request" });
    }
  });

  app.delete('/api/hidden-matches/:matchRequestId', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { matchRequestId } = req.params;
      
      await storage.unhideMatchRequest(userId, matchRequestId);
      res.status(204).send();
    } catch (error) {
      console.error("Error unhiding match request:", error);
      res.status(500).json({ message: "Failed to unhide match request" });
    }
  });

  // Chat message routes
  app.get('/api/messages/:connectionId', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { connectionId } = req.params;
      
      // Verify user is part of this connection (check both match connections AND connection requests)
      const userConnections = await storage.getUserConnections(userId);
      const connectionRequests = await storage.getConnectionRequests(userId);
      
      const hasMatchConnectionAccess = userConnections.some(c => c.id === connectionId);
      // Only allow messaging for accepted connection requests
      const hasConnectionRequestAccess = connectionRequests.some(c => c.id === connectionId && c.status === 'accepted');
      
      if (!hasMatchConnectionAccess && !hasConnectionRequestAccess) {
        return res.status(403).json({ message: "You don't have access to this conversation" });
      }
      
      const messages = await storage.getMessages(connectionId);
      res.json(messages);
    } catch (error) {
      console.error("Error fetching messages:", error);
      res.status(500).json({ message: "Failed to fetch messages" });
    }
  });

  app.post('/api/messages', authMiddleware, async (req: any, res) => {
    try {
      const senderId = req.user.id;
      const { connectionId, receiverId, message } = req.body;
      
      if (!connectionId || !receiverId || !message) {
        return res.status(400).json({ message: "connectionId, receiverId, and message are required" });
      }
      
      // Verify user is part of this connection (check both match connections AND connection requests)
      const userConnections = await storage.getUserConnections(senderId);
      const connectionRequests = await storage.getConnectionRequests(senderId);
      
      const matchConnection = userConnections.find(c => c.id === connectionId);
      // Only allow messaging for accepted connection requests
      const connectionRequest = connectionRequests.find(c => c.id === connectionId && c.status === 'accepted');
      
      if (!matchConnection && !connectionRequest) {
        return res.status(403).json({ message: "You don't have access to this conversation" });
      }
      
      // Verify receiverId is the other participant (works for both types)
      let validReceiver = false;
      if (matchConnection) {
        validReceiver = matchConnection.requesterId === receiverId || matchConnection.accepterId === receiverId;
      } else if (connectionRequest) {
        validReceiver = connectionRequest.senderId === receiverId || connectionRequest.receiverId === receiverId;
      }
      
      if (!validReceiver) {
        return res.status(400).json({ message: "Invalid receiverId for this connection" });
      }
      
      const newMessage = await storage.sendMessage({
        connectionId,
        senderId,
        receiverId,
        message,
      });
      
      // Broadcast message to receiver via WebSocket
      (app as any).broadcast?.toUsers([receiverId], {
        type: 'new_message',
        data: newMessage,
        message: 'New message received'
      });
      
      res.status(201).json(newMessage);
    } catch (error) {
      console.error("Error sending message:", error);
      res.status(500).json({ message: "Failed to send message" });
    }
  });

  // Notification routes
  app.get('/api/notifications', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { unreadOnly } = req.query;
      
      const notifications = await storage.getUserNotifications(
        userId,
        unreadOnly === 'true'
      );
      
      res.json(notifications);
    } catch (error) {
      console.error("Error fetching notifications:", error);
      res.status(500).json({ message: "Failed to fetch notifications" });
    }
  });

  app.get('/api/notifications/unread-count', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const count = await storage.getUnreadNotificationCount(userId);
      res.json({ count });
    } catch (error) {
      console.error("Error fetching unread count:", error);
      res.status(500).json({ message: "Failed to fetch unread count" });
    }
  });

  app.patch('/api/notifications/:id/read', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { id } = req.params;
      
      const notification = await storage.markNotificationAsRead(id, userId);
      
      res.json(notification);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to mark notification as read";
      
      if (errorMessage.includes("not found")) {
        return res.status(404).json({ message: errorMessage });
      }
      if (errorMessage.includes("Unauthorized")) {
        return res.status(403).json({ message: errorMessage });
      }
      
      console.error("Error marking notification as read:", error);
      res.status(500).json({ message: errorMessage });
    }
  });

  app.delete('/api/notifications/:id', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { id } = req.params;
      
      await storage.deleteNotification(id, userId);
      
      res.status(204).send();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to delete notification";
      
      if (errorMessage.includes("not found")) {
        return res.status(404).json({ message: errorMessage });
      }
      if (errorMessage.includes("Unauthorized")) {
        return res.status(403).json({ message: errorMessage });
      }
      
      console.error("Error deleting notification:", error);
      res.status(500).json({ message: errorMessage });
    }
  });

  // Voice channel routes
  app.get('/api/voice/channel/:connectionId', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { connectionId } = req.params;
      
      // Verify user is part of this connection
      const userConnections = await storage.getUserConnections(userId);
      const connectionRequests = await storage.getConnectionRequests(userId);
      
      const hasMatchConnectionAccess = userConnections.some(c => c.id === connectionId);
      const hasConnectionRequestAccess = connectionRequests.some(c => c.id === connectionId && c.status === 'accepted');
      
      if (!hasMatchConnectionAccess && !hasConnectionRequestAccess) {
        return res.status(403).json({ message: "You don't have access to this voice channel" });
      }
      
      const channel = await storage.getVoiceChannel(connectionId);
      if (!channel) {
        return res.json({ channel: null, participants: [] });
      }
      
      const participants = await storage.getVoiceParticipants(channel.id);
      res.json({ channel, participants });
    } catch (error) {
      console.error("Error fetching voice channel:", error);
      res.status(500).json({ message: "Failed to fetch voice channel" });
    }
  });

  app.post('/api/voice/join', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { connectionId } = req.body;
      
      if (!connectionId) {
        return res.status(400).json({ message: "connectionId is required" });
      }
      
      // Verify user is part of this connection
      const userConnections = await storage.getUserConnections(userId);
      const connectionRequests = await storage.getConnectionRequests(userId);
      
      const hasMatchConnectionAccess = userConnections.some(c => c.id === connectionId);
      const hasConnectionRequestAccess = connectionRequests.some(c => c.id === connectionId && c.status === 'accepted');
      
      if (!hasMatchConnectionAccess && !hasConnectionRequestAccess) {
        return res.status(403).json({ message: "You don't have access to this voice channel" });
      }
      
      // Leave any existing voice channel first
      const existingChannel = await storage.getUserActiveVoiceChannel(userId);
      if (existingChannel) {
        await storage.leaveVoiceChannel(existingChannel.id, userId);
      }
      
      // Get or create voice channel for this connection
      const channel = await storage.getOrCreateVoiceChannel(connectionId);
      
      // Join the channel
      const participant = await storage.joinVoiceChannel(channel.id, userId);
      const participants = await storage.getVoiceParticipants(channel.id);
      
      // Broadcast to other participants
      const otherUserIds = participants
        .filter(p => p.userId !== userId)
        .map(p => p.userId);
      
      if (otherUserIds.length > 0) {
        (app as any).broadcast?.toUsers(otherUserIds, {
          type: 'voice_participant_joined',
          data: { connectionId, participant, participants },
          message: 'User joined voice channel'
        });
      }
      
      res.json({ channel, participant, participants });
    } catch (error) {
      console.error("Error joining voice channel:", error);
      res.status(500).json({ message: "Failed to join voice channel" });
    }
  });

  app.post('/api/voice/leave', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { connectionId } = req.body;
      
      if (!connectionId) {
        return res.status(400).json({ message: "connectionId is required" });
      }
      
      const channel = await storage.getVoiceChannel(connectionId);
      if (!channel) {
        return res.json({ success: true });
      }
      
      // Get participants before leaving
      const participantsBefore = await storage.getVoiceParticipants(channel.id);
      const otherUserIds = participantsBefore
        .filter(p => p.userId !== userId)
        .map(p => p.userId);
      
      await storage.leaveVoiceChannel(channel.id, userId);
      
      // Broadcast to other participants
      if (otherUserIds.length > 0) {
        const participantsAfter = await storage.getVoiceParticipants(channel.id);
        (app as any).broadcast?.toUsers(otherUserIds, {
          type: 'voice_participant_left',
          data: { connectionId, userId, participants: participantsAfter },
          message: 'User left voice channel'
        });
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error leaving voice channel:", error);
      res.status(500).json({ message: "Failed to leave voice channel" });
    }
  });

  app.post('/api/voice/mute', authMiddleware, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { connectionId, isMuted } = req.body;
      
      if (!connectionId || isMuted === undefined) {
        return res.status(400).json({ message: "connectionId and isMuted are required" });
      }
      
      const channel = await storage.getVoiceChannel(connectionId);
      if (!channel) {
        return res.status(404).json({ message: "Voice channel not found" });
      }
      
      const participant = await storage.updateParticipantMuteStatus(channel.id, userId, isMuted);
      const participants = await storage.getVoiceParticipants(channel.id);
      
      // Broadcast mute status to other participants
      const otherUserIds = participants
        .filter(p => p.userId !== userId)
        .map(p => p.userId);
      
      if (otherUserIds.length > 0) {
        (app as any).broadcast?.toUsers(otherUserIds, {
          type: 'voice_participant_muted',
          data: { connectionId, userId, isMuted, participants },
          message: 'User mute status changed'
        });
      }
      
      res.json({ participant, participants });
    } catch (error) {
      console.error("Error updating mute status:", error);
      res.status(500).json({ message: "Failed to update mute status" });
    }
  });

  const httpServer = createServer(app);

  // Set up WebSocket server for real-time match updates
  const wss = new WebSocketServer({ 
    server: httpServer, 
    path: '/ws',
    verifyClient: (info: { origin: string; req: any }) => {
      // Validate Origin to prevent cross-site WebSocket hijacking
      const origin = info.origin;
      const host = info.req.headers.host;
      
      if (!origin || !host) {
        console.log('WebSocket connection rejected: Missing origin or host');
        return false;
      }
      
      try {
        // Extract hostname from origin using URL parsing for robustness
        const originHost = new URL(origin).host;
        
        // Require exact host match to prevent cross-site hijacking
        if (originHost === host) {
          return true;
        }
        
        console.log(`WebSocket connection rejected: Origin ${origin} (${originHost}) does not match host ${host}`);
        return false;
      } catch (error) {
        console.log(`WebSocket connection rejected: Invalid origin URL ${origin}`);
        return false;
      }
    }
  });

  // Store connected clients with their user info and heartbeat tracking
  const connectedClients = new Map<string, { ws: WebSocket; userId?: string; lastPong?: number }>();
  
  // Heartbeat mechanism to detect and clean up stale connections
  const heartbeatInterval = setInterval(() => {
    const now = Date.now();
    connectedClients.forEach(({ ws, lastPong }, clientId) => {
      if (lastPong && now - lastPong > 40000) { // 40 second timeout
        console.log(`Removing stale WebSocket connection: ${clientId}`);
        ws.terminate();
        connectedClients.delete(clientId);
      } else {
        // Send ping to check if connection is alive
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }
    });
  }, 30000); // Check every 30 seconds

  wss.on('connection', async (ws, req) => {
    const clientId = Math.random().toString(36).substring(2, 15);
    console.log(`WebSocket client connected: ${clientId}`);

    // Extract and validate session from the request headers
    let authenticatedUserId: string | undefined = undefined;
    
    try {
      // Parse cookies from the WebSocket request to get session
      const cookieHeader = req.headers.cookie;
      if (cookieHeader) {
        // Parse the session using the same session store as Express
        const sessionParser = getSession();
        
        // Create a mock request/response object to use the session parser
        const mockReq = { 
          headers: { cookie: cookieHeader },
          connection: req.socket,
          url: '/ws',
          method: 'GET'
        } as any;
        const mockRes = {} as any;

        await new Promise<void>((resolve, reject) => {
          sessionParser(mockReq, mockRes, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });

        // Check if user is authenticated through the session
        if (mockReq.session?.passport?.user) {
          authenticatedUserId = mockReq.session.passport.user;
          const userId: string = authenticatedUserId as string; // Create a typed constant for use in async callbacks
          connectedClients.set(clientId, { ws, userId: authenticatedUserId, lastPong: Date.now() });
          
          ws.send(JSON.stringify({
            type: 'auth_success',
            message: 'Authentication successful',
            userId: authenticatedUserId
          }));
          
          console.log(`WebSocket client ${clientId} authenticated as user ${authenticatedUserId}`);
          
          // Broadcast online status to connected users
          try {
            const userConnections = await storage.getUserConnections(userId);
            const connectionRequests = await storage.getConnectionRequests(userId);
            
            const connectedUserIds = new Set<string>();
            
            // Add users from accepted match connections
            userConnections.filter(c => c.status === 'accepted').forEach(conn => {
              const otherUserId = conn.requesterId === userId ? conn.accepterId : conn.requesterId;
              connectedUserIds.add(otherUserId);
            });
            
            // Add users from accepted direct connections
            connectionRequests.filter(c => c.status === 'accepted').forEach(req => {
              const otherUserId = req.senderId === userId ? req.receiverId : req.senderId;
              connectedUserIds.add(otherUserId);
            });
            
            // Broadcast to all connected users
            if (connectedUserIds.size > 0) {
              broadcastToUsers(Array.from(connectedUserIds), {
                type: 'user_online',
                userId: userId
              });
            }
          } catch (error) {
            console.error('Error broadcasting online status:', error);
          }
        } else {
          // Not authenticated - still allow connection but mark as anonymous
          connectedClients.set(clientId, { ws, lastPong: Date.now() });
          
          ws.send(JSON.stringify({
            type: 'auth_failed',
            message: 'Authentication required for personalized updates'
          }));
          
          console.log(`WebSocket client ${clientId} connected as anonymous`);
        }
      } else {
        // No cookies - anonymous connection
        connectedClients.set(clientId, { ws, lastPong: Date.now() });
        
        ws.send(JSON.stringify({
          type: 'auth_failed',
          message: 'No session found - login required for personalized updates'
        }));
        
        console.log(`WebSocket client ${clientId} connected as anonymous (no cookies)`);
      }
    } catch (error) {
      console.error('Error authenticating WebSocket connection:', error);
      connectedClients.set(clientId, { ws, lastPong: Date.now() });
      
      ws.send(JSON.stringify({
        type: 'auth_failed',
        message: 'Authentication error'
      }));
    }
    
    // Handle pong responses for heartbeat
    ws.on('pong', () => {
      const client = connectedClients.get(clientId);
      if (client) {
        client.lastPong = Date.now();
      }
    });

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message.toString());
        console.log(`WebSocket message from ${clientId}:`, data);
        
        const client = connectedClients.get(clientId);
        
        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        } else if (data.type === 'voice_channel_ready' || data.type === 'voice_channel_left' || data.type === 'webrtc_offer' || data.type === 'webrtc_answer' || data.type === 'webrtc_ice_candidate') {
          // WebRTC signaling and voice channel coordination - forward to target user with authorization
          if (!client?.userId) {
            ws.send(JSON.stringify({ 
              type: 'error', 
              message: 'Authentication required for WebRTC signaling' 
            }));
            return;
          }
          
          const { targetUserId, connectionId, offer, answer, candidate } = data;
          
          if (!targetUserId || !connectionId) {
            ws.send(JSON.stringify({ 
              type: 'error', 
              message: 'Target user ID and connection ID required for WebRTC signaling' 
            }));
            return;
          }
          
          // Verify that both sender and target are participants in this connection
          // Check both match connections and connection requests
          try {
            const userConnections = await storage.getUserConnections(client.userId);
            const matchConnection = userConnections.find(c => c.id === connectionId);
            
            const connectionRequests = await storage.getConnectionRequests(client.userId);
            const connectionRequest = connectionRequests.find(c => c.id === connectionId);
            
            const connection = matchConnection || connectionRequest;
            
            if (!connection) {
              ws.send(JSON.stringify({ 
                type: 'error', 
                message: 'Connection not found or you are not authorized' 
              }));
              return;
            }
            
            // Verify target is the other participant
            // Match connections use requesterId/accepterId, connection requests use senderId/receiverId
            const isValidTarget = matchConnection
              ? (matchConnection.requesterId === client.userId && matchConnection.accepterId === targetUserId) ||
                (matchConnection.accepterId === client.userId && matchConnection.requesterId === targetUserId)
              : (connectionRequest!.senderId === client.userId && connectionRequest!.receiverId === targetUserId) ||
                (connectionRequest!.receiverId === client.userId && connectionRequest!.senderId === targetUserId);
            
            if (!isValidTarget) {
              ws.send(JSON.stringify({ 
                type: 'error', 
                message: 'Target user is not a participant in this connection' 
              }));
              return;
            }
            
            // Connection must be accepted for voice
            if (connection.status !== 'accepted') {
              ws.send(JSON.stringify({ 
                type: 'error', 
                message: 'Connection must be accepted before initiating voice chat' 
              }));
              return;
            }
            
            // Authorization passed - forward the signaling message to the target user
            console.log(`[WebRTC] Forwarding ${data.type} from ${client.userId} to ${targetUserId}`);
            console.log(`[WebRTC] Connected clients count: ${connectedClients.size}`);
            
            let forwardedCount = 0;
            connectedClients.forEach((targetClient, targetClientId) => {
              console.log(`[WebRTC] Checking client ${targetClientId}: userId=${targetClient.userId}, readyState=${targetClient.ws.readyState}`);
              if (targetClient.userId === targetUserId && targetClient.ws.readyState === WebSocket.OPEN) {
                console.log(`[WebRTC] ✓ Forwarding to client ${targetClientId}`);
                targetClient.ws.send(JSON.stringify({
                  type: data.type,
                  data: {
                    connectionId,
                    offer,
                    answer,
                    candidate,
                    fromUserId: client.userId,
                    userId: client.userId  // Include userId for voice channel presence tracking
                  }
                }));
                forwardedCount++;
              }
            });
            
            console.log(`[WebRTC] Forwarded message to ${forwardedCount} client(s)`);
            
            if (forwardedCount === 0) {
              console.warn(`[WebRTC] WARNING: Target user ${targetUserId} has no active WebSocket connections`);
              ws.send(JSON.stringify({
                type: 'webrtc_error',
                message: 'Target user is not currently connected'
              }));
            }
          } catch (error) {
            console.error('Error verifying WebRTC authorization:', error);
            ws.send(JSON.stringify({ 
              type: 'error', 
              message: 'Failed to verify authorization' 
            }));
          }
        }
      } catch (error) {
        console.error('Error handling WebSocket message:', error);
      }
    });

    ws.on('close', async () => {
      const client = connectedClients.get(clientId);
      const userId = client?.userId;
      
      connectedClients.delete(clientId);
      console.log(`WebSocket client disconnected: ${clientId}`);
      
      // Broadcast offline status to connected users if this was the last connection for this user
      if (userId) {
        // Check if user has any other active connections
        const hasOtherConnections = Array.from(connectedClients.values()).some(c => c.userId === userId);
        
        if (!hasOtherConnections) {
          try {
            const userConnections = await storage.getUserConnections(userId);
            const connectionRequests = await storage.getConnectionRequests(userId);
            
            const connectedUserIds = new Set<string>();
            
            // Add users from accepted match connections
            userConnections.filter(c => c.status === 'accepted').forEach(conn => {
              const otherUserId = conn.requesterId === userId ? conn.accepterId : conn.requesterId;
              connectedUserIds.add(otherUserId);
            });
            
            // Add users from accepted direct connections
            connectionRequests.filter(c => c.status === 'accepted').forEach(req => {
              const otherUserId = req.senderId === userId ? req.receiverId : req.senderId;
              connectedUserIds.add(otherUserId);
            });
            
            // Broadcast to all connected users
            if (connectedUserIds.size > 0) {
              broadcastToUsers(Array.from(connectedUserIds), {
                type: 'user_offline',
                userId: userId
              });
            }
          } catch (error) {
            console.error('Error broadcasting offline status:', error);
          }
        }
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      connectedClients.delete(clientId);
    });

    // Send welcome message
    ws.send(JSON.stringify({
      type: 'welcome',
      message: 'Connected to GameMatch real-time updates'
    }));
  });

  // Helper function to broadcast real-time updates
  const broadcastToUsers = (userIds: string[], message: any) => {
    connectedClients.forEach((client, clientId) => {
      if (client.userId && userIds.includes(client.userId) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
      }
    });
  };

  // Helper function to broadcast to all authenticated users
  const broadcastToAll = (message: any) => {
    connectedClients.forEach((client, clientId) => {
      if (client.userId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(message));
      }
    });
  };

  // Store broadcast functions for use in API routes
  (app as any).broadcast = {
    toUsers: broadcastToUsers,
    toAll: broadcastToAll
  };

  return httpServer;
}
