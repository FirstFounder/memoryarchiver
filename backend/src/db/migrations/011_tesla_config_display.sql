ALTER TABLE tesla_config ADD COLUMN display_name TEXT;
ALTER TABLE tesla_config ADD COLUMN model_label TEXT;
ALTER TABLE tesla_config ADD COLUMN cached_odometer INTEGER;

UPDATE tesla_config
SET
  display_name = 'Bonzoid',
  model_label = '2015 P85D',
  pack_capacity_kwh = 68.0
WHERE vin = '5YJSA1H42FF096078';

UPDATE tesla_config
SET
  display_name = 'Bomber',
  model_label = '2012 85',
  pack_capacity_kwh = 68.0
WHERE vin = '5YJSA1CN8CFP01703';
