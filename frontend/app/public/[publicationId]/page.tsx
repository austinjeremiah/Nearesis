import '../../app.css';
import { NotConnected } from '@/components/nx/states';

/** Not connected to the API yet (WS6). */
export default function Page() {
  return (
    <div className="nx" style={{ maxWidth: 720, margin: '0 auto', padding: '12vh 24px' }}>
      <NotConnected what="Publication" stream="WS6" />
    </div>
  );
}
