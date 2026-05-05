export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen flex items-center justify-center bg-bg-primary px-4">
      <div
        className="absolute inset-0 opacity-30 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 800px 600px at 50% 30%, rgba(114,60,235,0.18) 0%, transparent 70%), radial-gradient(ellipse 600px 500px at 80% 70%, rgba(255,144,47,0.10) 0%, transparent 70%)',
        }}
      />
      <main className="relative z-10 w-full max-w-md">{children}</main>
    </div>
  );
}
