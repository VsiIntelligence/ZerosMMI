/** Test-only stand-in for @tanstack/react-router: a route file's `Route` is simply the options it was declared with. */
export const createFileRoute = () => (options) => options;
export const createRootRouteWithContext = () => (options) => options;
export const Link = () => null;
export const Outlet = () => null;
export const HeadContent = () => null;
export const Scripts = () => null;
export const useRouter = () => ({ invalidate() {} });
export const useNavigate = () => () => {};
