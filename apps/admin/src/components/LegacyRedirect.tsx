import { Navigate, useLocation } from 'react-router-dom'
import { legacyTarget } from '../navigation'

export default function LegacyRedirect() {
  const { pathname, search } = useLocation()
  return <Navigate replace to={legacyTarget(pathname, search)} />
}
