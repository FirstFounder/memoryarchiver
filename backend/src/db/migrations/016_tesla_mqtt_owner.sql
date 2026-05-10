ALTER TABLE tesla_config ADD COLUMN teslamate_car_id INTEGER;
ALTER TABLE tesla_config ADD COLUMN tesla_vehicle_id TEXT;
UPDATE tesla_config
SET teslamate_car_id = 1,
    tesla_vehicle_id = '1492932583349142'
WHERE vin = '5YJSA1CN8CFP01703';
UPDATE tesla_config
SET teslamate_car_id = 2,
    tesla_vehicle_id = '1492931646557842'
WHERE vin = '5YJSA1H42FF096078';
