import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';

interface DetailSectionProps {
  readonly title: string;
}

export const DetailSection: React.FC<React.PropsWithChildren<DetailSectionProps>> = ({ title, children }) => (
  <Card>
    <CardHeader>
      <CardTitle>{title}</CardTitle>
    </CardHeader>
    <CardContent>{children}</CardContent>
  </Card>
);
