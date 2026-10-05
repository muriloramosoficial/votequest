// Public client configuration only. Supabase anon/publishable keys are designed for the browser;
// never place the service_role/secret key in this file or in any VITE_ variable.
const env = import.meta.env || {};

export const SUPABASE_URL = env.VITE_SUPABASE_URL || 'https://tdxhgqmwzppuqzktaymc.supabase.co';
export const SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRkeGhncW13enBwdXF6a3RheW1jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTEyMjQxNDYsImV4cCI6MjEwNjgwMDE0Nn0.P849MJqfpvdPfeQDc37EAGaQNl0WtXX5FCd7BuBBp-I';
